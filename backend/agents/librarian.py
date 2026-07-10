from __future__ import annotations
import asyncio
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Callable

from backend.clustering.hierarchical import HierarchicalClusterer
from backend.clustering.namer import ClusterNamer
from backend.models import ChunkRecord, PaperRecord
from backend.services.embeddings import EmbeddingService
from backend.services.chunking import chunk_text
from backend.services.metadata_extraction import extract_metadata
from backend.services.objectstore import ObjectStore
from backend.services.ocr import OCRService
from backend.services.retrieval_defaults import LIBRARIAN_SIMILARITY_K
from backend.services.sse import sse
from backend.services.summarize import SummaryService, front_matter_text
from backend.services.vectorstore import VectorStore
from backend.store import PaperStore

class LibrarianAgent:
    def __init__(
        self,
        ocr_svc: OCRService,
        embed_svc: EmbeddingService,
        vstore: VectorStore,
        object_store: ObjectStore,
        paper_store: PaperStore,
        ocr_cache_dir: Path | None = None,
    ) -> None:
        self._ocr = ocr_svc
        self._embed = embed_svc
        self._vstore = vstore
        self._objects = object_store
        self._papers = paper_store
        # Defaults to the global `settings.ocr_cache_dir`; a per-user
        # `UserSpace` passes `settings.user_ocr_cache_dir(user_id)` so the
        # sidecar physically lands under `users/{user_id}/ocr_cache/` (plan
        # §4.1) even though `OCRService` itself stays a shared singleton.
        self._ocr_cache_dir = ocr_cache_dir
        self._summary = SummaryService()
        self._clusterer = HierarchicalClusterer()
        self._namer = ClusterNamer()

    # ── reindex ────────────────────────────────────────────────────────────

    async def reindex(
        self,
        progress_cb: Callable[[str, int], None],
    ) -> None:
        """Re-cluster every indexed paper without re-OCRing or re-embedding."""
        progress_cb("Loading vectors…", 5)
        paper_ids, vectors = self._vstore.get_all_paper_vectors()

        if not paper_ids:
            progress_cb("No papers indexed yet", 100)
            return

        progress_cb(f"Clustering {len(paper_ids)} papers…", 15)
        tree = self._clusterer.cluster(paper_ids, vectors)

        progress_cb("Naming clusters…", 35)
        await self._namer.name_tree(tree, self._papers.as_dict())

        progress_cb("Assigning paths…", 88)
        self._assign_paths(tree, self._papers.as_dict())

        progress_cb("Saving…", 96)
        await self._papers.save()

        progress_cb("Done", 100)

    # ── search ─────────────────────────────────────────────────────────────

    async def search(self, description: str) -> AsyncGenerator[str, None]:
        q_vec = await self._embed.embed_text(description)
        results = self._vstore.query_papers(q_vec, n_results=LIBRARIAN_SIMILARITY_K)
        papers = []
        for r in results:
            pid = r["paper_id"]
            record = self._papers.get(pid)
            if record:
                papers.append(record.model_dump(mode="json"))
        yield sse({"type": "result", "papers": papers})
        yield sse({"type": "done"})

    # ── ingest ─────────────────────────────────────────────────────────────

    async def ingest(
        self,
        paper_id: str,
        object_key: str,
        source_filename: str,
        status: str,
        progress_cb: Callable[[str, int], None],
    ) -> PaperRecord:
        """Ingest an already-stored PDF.

        `object_key` must already exist in the `ObjectStore` (the upload
        endpoint writes it there before kicking this off). This method never
        constructs a filesystem path itself — the only local path it ever
        touches is a throwaway tempfile it copies the object into so pypdf
        has something to open (plan §10.1 rule #4), which it always cleans
        up in a `finally`.
        """
        # OCR — copy the object out to a scratch tempfile; pypdf needs a
        # real path, but the tempfile's path is never persisted anywhere.
        progress_cb("Extracting text (OCR)…", 5)
        tmp_fd, tmp_name = tempfile.mkstemp(suffix=".pdf")
        tmp_path = Path(tmp_name)
        try:
            with open(tmp_fd, "wb") as tmp_file, self._objects.open(object_key) as src:
                shutil.copyfileobj(src, tmp_file)
            text = await self._ocr.extract(
                tmp_path, cache_key=paper_id, cache_dir=self._ocr_cache_dir
            )
        finally:
            tmp_path.unlink(missing_ok=True)

        if not text.strip():
            text = Path(source_filename).stem.replace("_", " ")
        title, author, year = extract_metadata(text, Path(source_filename).stem)
        progress_cb("OCR complete", 20)

        progress_cb("Summarizing front matter…", 22)
        summary_result = await self._summary.summarize(text, source_filename)
        title = summary_result.title or title
        author = summary_result.author_last or author
        year = summary_result.year or year
        summary = summary_result.summary

        # Chunk
        progress_cb("Chunking text…", 25)
        chunks = chunk_text(text)
        progress_cb("Chunked", 30)

        # Embed
        progress_cb("Embedding chunks…", 35)
        chunk_vecs = await self._embed.embed_batch(chunks)
        paper_vec = await self._paper_vector(text, source_filename, title, summary)
        progress_cb("Embedded", 60)

        # Store in Chroma
        progress_cb("Storing in vector DB…", 62)
        chunk_records = [
            ChunkRecord(paper_id=paper_id, chunk_index=i, text=c, token_count=len(c) // 4)
            for i, c in enumerate(chunks)
        ]
        self._vstore.add_chunks(paper_id, chunk_records, chunk_vecs)
        self._vstore.upsert_paper_vector(
            paper_id, paper_vec,
            {"filename": source_filename, "status": status,
             "source_filename": source_filename,
             "title": title or "", "author": author or "", "year": year or "",
             "summary": summary or ""},
        )
        progress_cb("Stored", 70)

        # Re-cluster
        progress_cb("Re-clustering library…", 72)
        paper_ids, vectors = self._vstore.get_all_paper_vectors()
        tree = self._clusterer.cluster(paper_ids, vectors)

        # Name — bottom-up so internal nodes are named after their children
        progress_cb("Naming folders…", 80)
        pending_record = PaperRecord(
            id=paper_id, filename=source_filename,
            source_filename=source_filename,
            status=status,  # type: ignore[arg-type]
            title=title, author=author, year=year,
            summary=summary,
            ingested_at=datetime.now(timezone.utc),
            ocr_cached=True,
        )
        all_records = {**self._papers.as_dict(), paper_id: pending_record}
        await self._namer.name_tree(tree, all_records)
        progress_cb("Folders named", 85)

        # Assign cluster paths to every paper in the store
        self._assign_paths(tree, all_records)

        # Find cluster path of the newly ingested paper
        cluster_path: str | None = self._find_path(tree, paper_id)

        record = pending_record
        record.cluster_path = cluster_path
        self._papers.put(record)

        progress_cb("Assigning paths…", 90)

        # Persist — no disk-tree rebuild: GET /api/tree is a pure function
        # of these records (backend/services/tree.py).
        await self._papers.save()
        progress_cb("Done", 100)
        return record

    async def _paper_vector(
        self,
        text: str,
        filename: str,
        title: str | None,
        summary: str | None,
    ) -> list[float]:
        if summary:
            return await self._embed.embed_text(f"{title or filename}\n\n{summary}")
        front = front_matter_text(text) or (title or filename)
        return self._embed.paper_vector(await self._embed.embed_batch(chunk_text(front)))

    # ── cluster tree helpers ───────────────────────────────────────────────

    async def _name_node(
        self,
        node,
        store: PaperStore,
        extra: tuple[str, str] | None = None,  # (paper_id, title) for newly ingested paper
    ) -> None:
        """Recursively name a ClusterNode tree bottom-up (leaves first)."""
        if node.is_leaf:
            titles: list[str] = []
            for pid in node.paper_ids:
                if extra and pid == extra[0]:
                    t = extra[1]
                else:
                    r = store.get(pid)
                    t = (r.title or r.filename) if r else None
                if t:
                    titles.append(t)
            node.name = await self._namer.name_cluster(titles)
        else:
            for child in node.children:
                await self._name_node(child, store, extra)
            # Internal node is named by its children's names, not raw titles
            node.name = await self._namer.name_cluster(
                [c.name for c in node.children if c.name]
            )

    def _assign_paths(
        self,
        nodes: list,
        records: dict,
        prefix: str = "",
    ) -> None:
        """Walk the cluster tree and write cluster_path onto every record."""
        for node in nodes:
            path = f"{prefix}/{node.name}" if prefix else node.name
            if node.is_leaf:
                for pid in node.paper_ids:
                    r = records.get(pid)
                    if r:
                        r.cluster_path = path
            else:
                self._assign_paths(node.children, records, path)

    def _find_path(
        self,
        nodes: list,
        target_pid: str,
        prefix: str = "",
    ) -> str | None:
        """Return the cluster_path for target_pid, or None if not found."""
        for node in nodes:
            path = f"{prefix}/{node.name}" if prefix else node.name
            if node.is_leaf:
                if target_pid in node.paper_ids:
                    return path
            else:
                result = self._find_path(node.children, target_pid, path)
                if result is not None:
                    return result
        return None
