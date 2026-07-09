from __future__ import annotations
import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Callable

from backend.clustering.hierarchical import HierarchicalClusterer
from backend.clustering.namer import ClusterNamer
from backend.models import ChunkRecord, PaperRecord
from backend.services.embeddings import EmbeddingService
from backend.services.filesystem import FilesystemService
from backend.services.ocr import OCRService
from backend.services.summarize import SummaryService, front_matter_text
from backend.services.vectorstore import VectorStore
from backend.store import PaperStore, paper_id_for, paper_store

MAX_CHARS = 2000
OVERLAP_CHARS = 150


def chunk_text(text: str) -> list[str]:
    if not text:
        return [""]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + MAX_CHARS
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - OVERLAP_CHARS
    return chunks


_SKIP_TITLE = re.compile(
    r"https?://|see discussions|researchgate\.net|arxiv\.org|doi\.org|"
    r"all rights reserved|©\s*\d{4}|open access|preprint|under review|"
    r"published in|proceedings of|workshop on|symposium on|"
    r"permits use|permitted use|creative commons|attribution|reproduction in any|"
    r"regulation or exceeds|obtain permission|^\s*arxiv:\d",
    re.IGNORECASE,
)
_FALSE_AUTHOR = {
    # Structure / boilerplate
    "Abstract", "Introduction", "Conclusion", "Related", "The", "All", "This",
    "Open", "Access", "Published", "Conference", "Proceedings", "Journal",
    "Under", "Review", "Submitted", "Figure", "Table", "Section", "Appendix",
    "References", "Background", "Method", "Approach", "System", "Based",
    "Creative", "Commons", "Permits", "Attribution", "Correspondence",
    # ML / AI domain words that appear in paper bodies
    "Neural", "Deep", "Learning", "Language", "Large", "Vision", "Graph",
    "Multi", "Agent", "Model", "Network", "Training", "Inference", "Data",
    "Sentiment", "Robot", "Develop", "Engineering", "Research", "Paper",
    "Scalable", "Adaptive", "Hierarchical", "Framework", "Benchmark",
    "Evaluation", "Analysis", "Study", "Survey", "Generative",
}


def extract_metadata(text: str, filename: str) -> tuple[str | None, str | None, str | None]:
    year_m = re.search(r"\b(19|20)\d{2}\b", text[:2000])
    year = year_m.group(0) if year_m else None

    lines = [l.strip() for l in text[:5000].splitlines() if l.strip()]

    title_idx = None
    title = None
    for i, line in enumerate(lines[:25]):
        if len(line) < 8 or len(line) > 200:
            continue
        if len(line.split()) < 3:  # single journal names / acronyms
            continue
        if _SKIP_TITLE.search(line):
            continue
        if re.search(r"\d+:\d+", line):  # journal vol:page
            continue
        title = re.sub(r'\b([A-Z])\s+([A-Z]{2,})', r'\1\2', line)[:150]
        title_idx = i
        break
    if not title:
        title = Path(filename).stem.replace("_", " ").replace("-", " ")

    # If title ends with a preposition it's likely split across PDF lines — extend it
    if title and title_idx is not None and re.search(
        r'(?:\b(for|in|of|with|the|an?|and|or|by|to|on|at|as|via|from)|:)\s*$', title, re.I
    ):
        for j in range(title_idx + 1, min(title_idx + 3, len(lines))):
            ext = lines[j]
            if ext and not _SKIP_TITLE.search(ext) and not re.search(r'\d+:\d+', ext):
                title = (title.rstrip() + " " + ext)[:150]
                break

    start = (title_idx + 1) if title_idx is not None else 1
    author_last = None
    for m in re.finditer(
        r"\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b",
        "\n".join(lines[start : start + 10]),
    ):
        if m.group(1) not in _FALSE_AUTHOR:
            author_last = m.group(1)
            break

    return title, author_last, year


class LibrarianAgent:
    def __init__(
        self,
        ocr_svc: OCRService,
        embed_svc: EmbeddingService,
        vstore: VectorStore,
        fs_svc: FilesystemService,
    ) -> None:
        self._ocr = ocr_svc
        self._embed = embed_svc
        self._vstore = vstore
        self._fs = fs_svc
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
        await self._namer.name_tree(tree, paper_store.as_dict())

        progress_cb("Assigning paths…", 80)
        self._assign_paths(tree, paper_store.as_dict())

        progress_cb("Rebuilding folder tree…", 88)
        self._fs.rebuild_tree(tree, paper_store.as_dict())

        progress_cb("Saving…", 96)
        paper_store.save()

        progress_cb("Done", 100)

    # ── search ─────────────────────────────────────────────────────────────

    async def search(self, description: str) -> AsyncGenerator[str, None]:
        q_vec = await self._embed.embed_text(description)
        results = self._vstore.query_papers(q_vec, n_results=3)
        papers = []
        for r in results:
            pid = r["paper_id"]
            record = paper_store.get(pid)
            if record:
                papers.append(record.model_dump(mode="json"))
        yield self._sse({"type": "result", "papers": papers})
        yield self._sse({"type": "done"})

    # ── ingest ─────────────────────────────────────────────────────────────

    async def ingest(
        self,
        pdf_path: Path,
        status: str,
        progress_cb: Callable[[str, int], None],
    ) -> PaperRecord:
        paper_id = paper_id_for(pdf_path)

        # OCR
        progress_cb("Extracting text (OCR)…", 5)
        text = await self._ocr.extract(pdf_path)
        if not text.strip():
            text = pdf_path.stem.replace("_", " ")
        title, author, year = extract_metadata(text, pdf_path.stem)
        progress_cb("OCR complete", 20)

        progress_cb("Summarizing front matter…", 22)
        summary_result = await self._summary.summarize(text, pdf_path.name)
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
        paper_vec = await self._paper_vector(text, pdf_path.name, title, summary)
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
            {"filename": pdf_path.name, "status": status,
             "original_path": str(pdf_path.resolve()),
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
            id=paper_id, filename=pdf_path.name,
            original_path=str(pdf_path.resolve()),
            status=status,  # type: ignore[arg-type]
            title=title, author=author, year=year,
            summary=summary,
            ingested_at=datetime.now(timezone.utc),
            ocr_cached=True,
        )
        all_records = {**paper_store.as_dict(), paper_id: pending_record}
        await self._namer.name_tree(tree, all_records)
        progress_cb("Folders named", 85)

        # Assign cluster paths to every paper in the store
        self._assign_paths(tree, all_records)

        # Find cluster path of the newly ingested paper
        cluster_path: str | None = self._find_path(tree, paper_id)

        record = pending_record
        record.cluster_path = cluster_path
        record.symlink_name = self._fs.make_symlink_name(record)
        paper_store.put(record)

        # Rebuild FS
        progress_cb("Rebuilding folder tree…", 87)
        self._fs.rebuild_tree(tree, paper_store.as_dict())
        progress_cb("Tree rebuilt", 95)

        # Persist
        paper_store.save()
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
        """Walk the cluster tree and write cluster_path + symlink_name onto every record."""
        for node in nodes:
            path = f"{prefix}/{node.name}" if prefix else node.name
            if node.is_leaf:
                for pid in node.paper_ids:
                    r = records.get(pid)
                    if r:
                        r.cluster_path = path
                        r.symlink_name = self._fs.make_symlink_name(r)
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

    @staticmethod
    def _sse(data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"
