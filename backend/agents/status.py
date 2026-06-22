from __future__ import annotations
import json
from typing import AsyncGenerator

from backend.services.embeddings import EmbeddingService
from backend.services.filesystem import FilesystemService
from backend.services.vectorstore import VectorStore
from backend.store import paper_store


class StatusAgent:
    def __init__(
        self,
        embed_svc: EmbeddingService,
        vstore: VectorStore,
        fs_svc: FilesystemService,
    ) -> None:
        self._embed  = embed_svc
        self._vstore = vstore
        self._fs     = fs_svc

    async def set_status(
        self, description: str, status: str
    ) -> AsyncGenerator[str, None]:
        # Semantic search to identify which paper the user means
        q_vec   = await self._embed.embed_text(description)
        results = self._vstore.query_papers(q_vec, n_results=1)

        if not results:
            yield self._sse({"type": "chunk", "text": "I couldn't find a matching paper in the library."})
            yield self._sse({"type": "done"})
            return

        pid    = results[0]["paper_id"]
        record = paper_store.get(pid)
        if not record:
            yield self._sse({"type": "chunk", "text": "Paper found in index but missing from the store — try reindexing."})
            yield self._sse({"type": "done"})
            return

        title = record.title or record.filename.replace(".pdf", "")
        label = "read" if status == "read" else "to-read"

        if record.status == status:
            yield self._sse({"type": "chunk", "text": f"**{title}** is already marked as {label}."})
            yield self._sse({"type": "done"})
            return

        # Update in-memory store
        old_name       = record.symlink_name
        record.status  = status  # type: ignore[assignment]
        record.symlink_name = self._fs.make_symlink_name(record)

        # Rename symlink on disk + update Chroma metadata
        if old_name:
            self._fs.update_symlink_status(record, old_name)
        self._vstore.update_paper_status(pid, status)
        paper_store.save()

        yield self._sse({"type": "status_update", "paper": record.model_dump(mode="json")})
        yield self._sse({"type": "chunk", "text": f"Marked **{title}** as {label}."})
        yield self._sse({"type": "done"})

    @staticmethod
    def _sse(data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"
