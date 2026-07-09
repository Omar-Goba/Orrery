from __future__ import annotations
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from backend.models import ChunkRecord

# Legacy, pre-multiuser collection names. Kept as the default when `user_id`
# is omitted for migration tooling and narrow compatibility tests; normal API
# routes use per-user `VectorStore` instances via `UserSpace`.
CHUNKS_COLLECTION = "paper_chunks"
PAPERS_COLLECTION = "paper_vectors"
COSINE_META = {"hnsw:space": "cosine"}


class VectorStore:
    """Per-user facade over ONE shared `chromadb.PersistentClient` (§4.2).

    The client itself is constructed once, in `lifespan`
    (`VectorStore.build_client`), and is user-agnostic — only the collection
    *names* are per-user (`u{user_id}_chunks` / `u{user_id}_papers`). This
    was chosen over a shared collection with a `user_id` metadata filter
    because a forgotten `where={"user_id": ...}` in a future query is a
    silent cross-user leak; a wrong collection name is a loud empty result.

    Every method below the constructor is unchanged from the pre-multiuser
    version — this class is a mechanical scoping wrap, not a rewrite of the
    query/embedding logic.
    """

    def __init__(
        self,
        client: chromadb.PersistentClient,
        user_id: str | None = None,
    ) -> None:
        if user_id is None:
            chunks_name, papers_name = CHUNKS_COLLECTION, PAPERS_COLLECTION
        else:
            chunks_name, papers_name = f"u{user_id}_chunks", f"u{user_id}_papers"
        self._client = client
        self._chunks = self._client.get_or_create_collection(
            chunks_name, metadata=COSINE_META
        )
        self._papers = self._client.get_or_create_collection(
            papers_name, metadata=COSINE_META
        )

    @staticmethod
    def build_client(persist_path: Path) -> chromadb.PersistentClient:
        """Build the one shared `PersistentClient` for the whole process.

        Called once in `lifespan`; `SpaceRegistry` constructs per-user
        `VectorStore` facades from the same client instance — never one client
        per user (plan §4.2/§4.4).
        """
        persist_path.mkdir(parents=True, exist_ok=True)
        return chromadb.PersistentClient(
            path=str(persist_path),
            settings=ChromaSettings(anonymized_telemetry=False),
        )

    # ── ingestion ──────────────────────────────────────────────────────────

    def add_chunks(
        self,
        paper_id: str,
        chunks: list[ChunkRecord],
        vectors: list[list[float]],
    ) -> None:
        if not chunks:
            return
        self._chunks.upsert(
            ids=[f"{paper_id}_chunk_{c.chunk_index}" for c in chunks],
            embeddings=vectors,
            documents=[c.text for c in chunks],
            metadatas=[{"paper_id": paper_id, "chunk_index": c.chunk_index} for c in chunks],
        )

    def upsert_paper_vector(
        self,
        paper_id: str,
        vector: list[float],
        metadata: dict[str, Any],
    ) -> None:
        safe_meta = {k: (v if v is not None else "") for k, v in metadata.items()}
        self._papers.upsert(
            ids=[paper_id],
            embeddings=[vector],
            metadatas=[safe_meta],
        )

    # ── retrieval ──────────────────────────────────────────────────────────

    def query_chunks(
        self, query_vector: list[float], n_results: int = 5
    ) -> list[dict]:
        total = self._chunks.count()
        if total == 0:
            return []
        n = min(n_results, total)
        result = self._chunks.query(
            query_embeddings=[query_vector],
            n_results=n,
            include=["documents", "metadatas", "distances"],
        )
        out = []
        for doc, meta, dist in zip(
            result["documents"][0],
            result["metadatas"][0],
            result["distances"][0],
        ):
            out.append({"text": doc, "paper_id": meta["paper_id"],
                        "chunk_index": meta["chunk_index"], "distance": dist})
        return out

    def get_all_paper_vectors(self) -> tuple[list[str], list[list[float]]]:
        total = self._papers.count()
        if total == 0:
            return [], []
        result = self._papers.get(include=["embeddings"])
        return result["ids"], result["embeddings"]

    def get_paper_metadata(self, paper_id: str) -> dict | None:
        result = self._papers.get(ids=[paper_id], include=["metadatas"])
        if result["ids"]:
            return result["metadatas"][0]
        return None

    def query_papers(
        self, query_vector: list[float], n_results: int = 3
    ) -> list[dict]:
        total = self._papers.count()
        if total == 0:
            return []
        n = min(n_results, total)
        result = self._papers.query(
            query_embeddings=[query_vector],
            n_results=n,
            include=["metadatas", "distances"],
        )
        out = []
        for pid, meta, dist in zip(
            result["ids"][0],
            result["metadatas"][0],
            result["distances"][0],
        ):
            out.append({"paper_id": pid, "distance": dist, **meta})
        return out

    def update_paper_status(self, paper_id: str, status: str) -> None:
        existing = self._papers.get(ids=[paper_id], include=["metadatas"])
        if not existing["ids"]:
            return
        meta = dict(existing["metadatas"][0])
        meta["status"] = status
        self._papers.update(ids=[paper_id], metadatas=[meta])

    # ── existence / deletion ───────────────────────────────────────────────

    def paper_exists(self, paper_id: str) -> bool:
        result = self._papers.get(ids=[paper_id])
        return len(result["ids"]) > 0

    def delete_paper(self, paper_id: str) -> None:
        self._papers.delete(ids=[paper_id])
        existing = self._chunks.get(where={"paper_id": paper_id})
        if existing["ids"]:
            self._chunks.delete(ids=existing["ids"])

    def count_papers(self) -> int:
        return self._papers.count()

    # ── bulk raw access (migration only) ────────────────────────────────────
    # Deliberately narrow: `backend/tools/migrate_to_multiuser.py` (plan §11)
    # needs to dump a whole legacy collection and bulk-`upsert` into a fresh
    # per-user one, id-for-id, without going through the chunk/query-shaped
    # methods above. No other caller should need these — everyday code reads
    # and writes one paper/chunk at a time through the methods above.

    def raw_chunks_collection(self):
        return self._chunks

    def raw_papers_collection(self):
        return self._papers
