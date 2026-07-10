from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any

import chromadb
from loguru import logger
from sqlmodel import Session, select

from backend.auth.db import get_engine, init_db
from backend.auth.models import User
from backend.config import settings
from backend.models import ChunkRecord
from backend.services.embedder_registry import EmbedderIdentity, save_embedder_identity
from backend.services.embeddings import EmbeddingService
from backend.services.vectorstore import VectorStore
from backend.space import SpaceRegistry


REEMBED_PROGRESS: dict[str, Any] = {
    "running": False,
    "status": "idle",
    "users": {},
    "total_papers": 0,
    "done_papers": 0,
    "error": None,
}


def reembed_status() -> dict[str, Any]:
    return {
        "running": REEMBED_PROGRESS["running"],
        "status": REEMBED_PROGRESS["status"],
        "users": dict(REEMBED_PROGRESS["users"]),
        "total_papers": REEMBED_PROGRESS["total_papers"],
        "done_papers": REEMBED_PROGRESS["done_papers"],
        "error": REEMBED_PROGRESS["error"],
    }


class ReembedJob:
    def __init__(
        self,
        *,
        registry: SpaceRegistry,
        old_client: chromadb.PersistentClient,
        old_persist_dir: Path,
        embed_svc: EmbeddingService,
        new_identity: EmbedderIdentity,
        chroma_persist_dir: Path,
    ) -> None:
        self._registry = registry
        self._old_client = old_client
        self._old_persist_dir = old_persist_dir
        self._embed = embed_svc
        self._identity = new_identity
        self._chroma_persist_dir = chroma_persist_dir
        self._parent = chroma_persist_dir.parent

    async def run(self) -> None:
        if REEMBED_PROGRESS["running"]:
            logger.warning("Re-embed job requested while one is already running")
            return

        REEMBED_PROGRESS.update(
            {
                "running": True,
                "status": "in_progress",
                "users": {},
                "total_papers": 0,
                "done_papers": 0,
                "error": None,
            }
        )
        new_client: chromadb.PersistentClient | None = None
        new_dir = self._new_dir()
        try:
            logger.warning(
                "Embedder identity changed; starting background re-embed into {}",
                new_dir,
            )
            new_client = VectorStore.build_client(new_dir)
            users = self._user_ids()
            for user_id in users:
                REEMBED_PROGRESS["users"][user_id] = "in_progress"
                copied = await self._copy_user(
                    user_id,
                    new_client,
                    skip_existing=True,
                    count_total=True,
                )
                REEMBED_PROGRESS["done_papers"] += copied
                REEMBED_PROGRESS["users"][user_id] = "done"
                logger.info("Re-embed user copied user_id={} papers={}", user_id, copied)

            await self._swap(new_client, new_dir, users)
            REEMBED_PROGRESS["status"] = "done"
            logger.warning(
                "Embedder swap complete. Run /api/reindex manually when ready so clusters use the new geometry."
            )
        except Exception as exc:
            REEMBED_PROGRESS["status"] = "error"
            REEMBED_PROGRESS["error"] = str(exc)
            logger.exception("Re-embed job failed; old vector store remains active")
        finally:
            REEMBED_PROGRESS["running"] = False

    def _new_dir(self) -> Path:
        preferred = self._parent / "chroma_new"
        if preferred.resolve() != self._old_persist_dir.resolve():
            return preferred
        return self._parent / "chroma_next"

    def _user_ids(self) -> list[str]:
        user_ids: set[str] = set()
        init_db()
        with Session(get_engine()) as db:
            for user in db.exec(select(User)).all():
                user_ids.add(user.id)
        if settings.users_dir.exists():
            for child in settings.users_dir.iterdir():
                if child.is_dir():
                    user_ids.add(child.name)
        return sorted(user_ids)

    async def _copy_user(
        self,
        user_id: str,
        new_client: chromadb.PersistentClient,
        *,
        skip_existing: bool,
        count_total: bool,
    ) -> int:
        old_store = VectorStore(self._old_client, user_id=user_id)
        new_store = VectorStore(new_client, user_id=user_id)
        paper_result = old_store.raw_papers_collection().get(include=["metadatas"])
        paper_ids = list(paper_result.get("ids") or [])
        paper_metas = list(paper_result.get("metadatas") or [])
        if count_total:
            REEMBED_PROGRESS["total_papers"] += len(paper_ids)

        copied = 0
        for paper_id, paper_meta in zip(paper_ids, paper_metas):
            if skip_existing and new_store.paper_exists(paper_id):
                self._refresh_paper_metadata(new_store, paper_id, dict(paper_meta or {}))
                continue
            await self._copy_paper(old_store, new_store, paper_id, dict(paper_meta or {}))
            copied += 1
            await asyncio.sleep(0)
        return copied

    def _refresh_paper_metadata(
        self,
        new_store: VectorStore,
        paper_id: str,
        paper_meta: dict[str, Any],
    ) -> None:
        safe_meta = {
            key: (value if value is not None else "")
            for key, value in paper_meta.items()
        }
        new_store.raw_papers_collection().update(ids=[paper_id], metadatas=[safe_meta])

    async def _copy_paper(
        self,
        old_store: VectorStore,
        new_store: VectorStore,
        paper_id: str,
        paper_meta: dict[str, Any],
    ) -> None:
        chunk_result = old_store.raw_chunks_collection().get(
            where={"paper_id": paper_id},
            include=["documents", "metadatas"],
        )
        rows = sorted(
            zip(
                chunk_result.get("documents") or [],
                chunk_result.get("metadatas") or [],
            ),
            key=lambda row: int((row[1] or {}).get("chunk_index", 0)),
        )
        chunks = [
            ChunkRecord(
                paper_id=paper_id,
                chunk_index=int((meta or {}).get("chunk_index", index)),
                text=document or "",
                token_count=len(document or "") // 4,
            )
            for index, (document, meta) in enumerate(rows)
        ]
        vectors = await self._embed.embed_batch([chunk.text for chunk in chunks]) if chunks else []
        if chunks:
            new_store.add_chunks(paper_id, chunks, vectors)
        new_store.upsert_paper_vector(
            paper_id,
            self._embed.paper_vector(vectors, dim=self._identity.dim),
            paper_meta,
        )

    async def _swap(
        self,
        new_client: chromadb.PersistentClient,
        new_dir: Path,
        users: list[str],
    ) -> None:
        logger.info("Re-embed final swap begins")
        self._registry.pause_ingest()
        try:
            diff_count = 0
            users = sorted(set(users) | set(self._user_ids()))
            for user_id in users:
                diff_count += await self._copy_user(
                    user_id,
                    new_client,
                    skip_existing=True,
                    count_total=False,
                )
            logger.info("Re-embed final diff copied papers={}", diff_count)

            await self._registry.swap_client(new_client)
            save_embedder_identity(
                self._chroma_persist_dir,
                self._identity.with_active_persist_dir(new_dir),
            )
        finally:
            self._registry.resume_ingest()

        await asyncio.to_thread(self._rotate_old_dir)
        logger.info("Re-embed final swap finished")

    def _rotate_old_dir(self) -> None:
        old_dir = self._parent / "chroma_old"
        if old_dir.exists():
            shutil.rmtree(old_dir)
        if self._old_persist_dir.exists():
            self._old_persist_dir.rename(old_dir)
