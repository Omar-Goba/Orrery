"""Per-user runtime context: `UserSpace` + `SpaceRegistry` (plan §4.4).

`main.py`'s `lifespan` constructs the one process-wide `SpaceRegistry` and
stores it on `app.state.space_registry`; normal API routes resolve
`current_space` from there so each request uses the authenticated user's own
paper store, vector collections, object prefix, and agents.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass

import chromadb
from fastapi import Depends, Request

from backend.agents.curator import CuratorAgent
from backend.agents.librarian import LibrarianAgent
from backend.agents.master import MasterAgent
from backend.agents.oracle import OracleAgent
from backend.agents.status import StatusAgent
from backend.auth.deps import current_user
from backend.auth.models import User
from backend.config import settings
from backend.services.embeddings import EmbeddingService
from backend.services.objectstore import ObjectStore, ScopedObjectStore
from backend.services.ocr import OCRService
from backend.services.vectorstore import VectorStore
from backend.store import PaperStore

# "Tens of users" per plan §4.4's concurrency note. A `UserSpace` is cheap to
# rebuild on a cache miss (its own small JSON file, a couple of Chroma
# collection handles on the *shared* client, and a handful of agent objects
# with no open network connections of their own), so evicting the
# least-recently-used entry once this cap is exceeded is a low-risk trade
# against unbounded memory growth — not a correctness concern.
DEFAULT_MAX_SPACES = 64


@dataclass
class UserSpace:
    user_id: str
    papers: PaperStore
    vstore: VectorStore
    objects: ScopedObjectStore
    oracle: OracleAgent
    librarian: LibrarianAgent
    status_agent: StatusAgent
    master: MasterAgent
    curator: CuratorAgent


class SpaceRegistry:
    """LRU cache of live `UserSpace`s; one per user, built on first request.

    Implementation choice: a plain `OrderedDict` used as a hand-rolled LRU
    (`move_to_end` on every hit, `popitem(last=False)` once `max_size` is
    exceeded) rather than `functools.lru_cache`. Two reasons: (1) the cache
    key (`user_id`) is already known before the expensive part (building
    five agents) runs, so there's no benefit to a decorator-based memoizer
    over an explicit dict; (2) `lru_cache` wraps a *function*, which would
    mean either a module-level registry (defeats per-test isolation — see
    `backend/tests/conftest.py`'s `tmp_dbs` fixture, which points `settings`
    at a fresh tmp directory per test) or an awkward `self`-bound-method
    workaround. A plain dict is O(1) and trivially instance-scoped, which is
    exactly what "tens of users" needs.
    """

    def __init__(
        self,
        *,
        chroma_client: chromadb.PersistentClient,
        object_store: ObjectStore,
        ocr_svc: OCRService,
        embed_svc: EmbeddingService,
        max_size: int = DEFAULT_MAX_SPACES,
    ) -> None:
        self._client = chroma_client
        self._objects = object_store
        self._ocr = ocr_svc
        self._embed = embed_svc
        self._max_size = max_size
        self._spaces: "OrderedDict[str, UserSpace]" = OrderedDict()
        self._ingest_resume = asyncio.Event()
        self._ingest_resume.set()
        # Guards `get()` against two concurrent requests for the same
        # not-yet-cached user racing to build (and discard) two `UserSpace`s.
        # `_build` itself does no I/O it needs to await (agents/services only
        # touch disk lazily, on first real use), so holding this across a
        # synchronous `get()` call is cheap.
        self._lock = asyncio.Lock()

    def get(self, user_id: str) -> UserSpace:
        """Synchronous cache lookup/build. Prefer `get_locked` (the
        `current_space` dependency uses it) when called from concurrent
        request handlers; this method itself does not guard against a
        build race."""
        existing = self._spaces.get(user_id)
        if existing is not None:
            self._spaces.move_to_end(user_id)
            return existing
        space = self._build(user_id)
        self._spaces[user_id] = space
        if len(self._spaces) > self._max_size:
            self._spaces.popitem(last=False)
        return space

    async def get_locked(self, user_id: str) -> UserSpace:
        async with self._lock:
            return self.get(user_id)

    async def wait_for_ingest_allowed(self) -> None:
        await self._ingest_resume.wait()

    def pause_ingest(self) -> None:
        self._ingest_resume.clear()

    def resume_ingest(self) -> None:
        self._ingest_resume.set()

    @property
    def ingest_paused(self) -> bool:
        return not self._ingest_resume.is_set()

    async def swap_client(self, new_client: chromadb.PersistentClient) -> None:
        async with self._lock:
            self._client = new_client
            self._spaces.clear()

    def _build(self, user_id: str) -> UserSpace:
        papers = PaperStore(settings.user_papers_json(user_id))
        papers.load()

        vstore = VectorStore(self._client, user_id=user_id)
        objects = ScopedObjectStore(
            self._objects, settings.user_object_prefix(user_id)
        )

        oracle = OracleAgent(self._embed, vstore, papers)
        librarian = LibrarianAgent(
            self._ocr,
            self._embed,
            vstore,
            objects,
            papers,
            ocr_cache_dir=settings.user_ocr_cache_dir(user_id),
        )
        status_agent = StatusAgent(self._embed, vstore, papers)
        master = MasterAgent(oracle, librarian, status_agent)
        curator = CuratorAgent(papers)

        return UserSpace(
            user_id=user_id,
            papers=papers,
            vstore=vstore,
            objects=objects,
            oracle=oracle,
            librarian=librarian,
            status_agent=status_agent,
            master=master,
            curator=curator,
        )


def get_space_registry(request: Request) -> SpaceRegistry:
    return request.app.state.space_registry


async def current_space(
    user: User = Depends(current_user),
    registry: SpaceRegistry = Depends(get_space_registry),
) -> UserSpace:
    """`current_user` -> `registry.get(user.id)` -> `UserSpace`."""
    return await registry.get_locked(user.id)


async def wait_for_ingest_gate(
    registry: SpaceRegistry = Depends(get_space_registry),
) -> None:
    await registry.wait_for_ingest_allowed()
