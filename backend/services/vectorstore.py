from __future__ import annotations
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from backend.models import ChunkRecord

CHUNKS_COLLECTION = "paper_chunks"
PAPERS_COLLECTION = "paper_vectors"
COSINE_META = {"hnsw:space": "cosine"}


class VectorStore:
    def __init__(self, persist_path: Path) -> None:
        persist_path.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=str(persist_path),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self._chunks = self._client.get_or_create_collection(
            CHUNKS_COLLECTION, metadata=COSINE_META
        )
        self._papers = self._client.get_or_create_collection(
            PAPERS_COLLECTION, metadata=COSINE_META
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
