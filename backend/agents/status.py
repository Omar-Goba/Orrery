from __future__ import annotations
from typing import AsyncGenerator

from backend.services.embeddings import EmbeddingService
from backend.services.sse import sse
from backend.services.vectorstore import VectorStore
from backend.store import PaperStore


class StatusAgent:
    def __init__(
        self,
        embed_svc: EmbeddingService,
        vstore: VectorStore,
        paper_store: PaperStore,
    ) -> None:
        self._embed  = embed_svc
        self._vstore = vstore
        self._papers = paper_store

    async def set_status(
        self, description: str, status: str
    ) -> AsyncGenerator[str, None]:
        # Semantic search to identify which paper the user means
        q_vec   = await self._embed.embed_text(description)
        results = self._vstore.query_papers(q_vec, n_results=1)

        if not results:
            yield sse({"type": "chunk", "text": "I couldn't find a matching paper in the library."})
            yield sse({"type": "done"})
            return

        pid    = results[0]["paper_id"]
        record = self._papers.get(pid)
        if not record:
            yield sse({"type": "chunk", "text": "Paper found in index but missing from the store — try reindexing."})
            yield sse({"type": "done"})
            return

        title = record.title or record.filename.replace(".pdf", "")
        label = "read" if status == "read" else "to-read"

        if record.status == status:
            yield sse({"type": "chunk", "text": f"**{title}** is already marked as {label}."})
            yield sse({"type": "done"})
            return

        # Update in-memory store + Chroma metadata — no disk mutation, the
        # tree is a pure function of records (backend/services/tree.py).
        record.status  = status  # type: ignore[assignment]
        self._vstore.update_paper_status(pid, status)
        await self._papers.save()

        yield sse({"type": "status_update", "paper": record.model_dump(mode="json")})
        yield sse({"type": "chunk", "text": f"Marked **{title}** as {label}."})
        yield sse({"type": "done"})
