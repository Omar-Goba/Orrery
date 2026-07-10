"""Unit tests for `UserSpace` / `SpaceRegistry` (plan §4.4).

These prove the registry actually gives each user an isolated galaxy — the
whole point of namespacing by store/collection/prefix instead of a
`WHERE owner_id =` filter (plan §2): there should be no code path that could
accidentally return or accept another user's data.

`current_space` is also exercised directly here as a plain async function.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.models import PaperRecord
from backend.services.embeddings import EmbeddingService
from backend.services.objectstore import LocalObjectStore
from backend.services.ocr import OCRService
from backend.services.vectorstore import VectorStore
from backend.space import SpaceRegistry, UserSpace


@pytest.fixture()
def registry(tmp_dbs: Path) -> SpaceRegistry:
    from backend.config import settings

    client = VectorStore.build_client(settings.chroma_persist_dir)
    object_store = LocalObjectStore(settings.objects_dir)
    return SpaceRegistry(
        chroma_client=client,
        object_store=object_store,
        ocr_svc=OCRService(),
        embed_svc=EmbeddingService(),
    )


def _record(paper_id: str) -> PaperRecord:
    return PaperRecord(
        id=paper_id,
        filename=f"{paper_id}.pdf",
        source_filename=f"{paper_id}.pdf",
        status="toread",
    )


# ── identity / caching ───────────────────────────────────────────────────────

def test_get_returns_the_same_instance_for_the_same_user(
    registry: SpaceRegistry,
) -> None:
    a1 = registry.get("user-a")
    a2 = registry.get("user-a")
    assert a1 is a2


def test_get_returns_different_instances_for_different_users(
    registry: SpaceRegistry,
) -> None:
    a = registry.get("user-a")
    b = registry.get("user-b")
    assert a is not b
    assert a.user_id == "user-a"
    assert b.user_id == "user-b"
    assert isinstance(a, UserSpace) and isinstance(b, UserSpace)


def test_lru_evicts_the_least_recently_used_space(tmp_dbs: Path) -> None:
    from backend.config import settings

    client = VectorStore.build_client(settings.chroma_persist_dir)
    object_store = LocalObjectStore(settings.objects_dir)
    registry = SpaceRegistry(
        chroma_client=client,
        object_store=object_store,
        ocr_svc=OCRService(),
        embed_svc=EmbeddingService(),
        max_size=2,
    )
    a = registry.get("a")
    registry.get("b")
    # touch `a` so `b` becomes the least-recently-used entry
    registry.get("a")
    registry.get("c")  # pushes out "b", not "a"

    assert registry.get("a") is a  # still cached, same instance
    assert "b" not in registry._spaces
    assert "c" in registry._spaces


# ── isolation: PaperStore ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_paper_records_are_isolated_between_user_spaces(
    registry: SpaceRegistry,
) -> None:
    space_a = registry.get("alice")
    space_b = registry.get("bob")

    space_a.papers.put(_record("shared-id"))
    await space_a.papers.save()

    assert space_a.papers.get("shared-id") is not None
    assert space_b.papers.get("shared-id") is None
    assert space_a.papers.as_dict() != space_b.papers.as_dict()

    # And it's not just in-memory isolation — the on-disk files differ too.
    from backend.config import settings

    alice_json = settings.user_papers_json("alice")
    bob_json = settings.user_papers_json("bob")
    assert alice_json.exists()
    assert not bob_json.exists()
    assert "shared-id" in alice_json.read_text()


@pytest.mark.asyncio
async def test_reloading_a_users_papers_json_does_not_leak_into_a_fresh_space(
    registry: SpaceRegistry, tmp_dbs: Path
) -> None:
    """A completely fresh `SpaceRegistry` pointed at the same `dbs_dir`
    should see user A's persisted papers but never user B's, proving
    isolation survives a process restart (a second `SpaceRegistry`), not
    just LRU-cache identity within one."""
    from backend.config import settings

    space_a = registry.get("alice")
    space_a.papers.put(_record("persisted-id"))
    await space_a.papers.save()

    client2 = VectorStore.build_client(settings.chroma_persist_dir)
    object_store2 = LocalObjectStore(settings.objects_dir)
    registry2 = SpaceRegistry(
        chroma_client=client2,
        object_store=object_store2,
        ocr_svc=OCRService(),
        embed_svc=EmbeddingService(),
    )
    reloaded_a = registry2.get("alice")
    reloaded_b = registry2.get("bob")
    assert reloaded_a.papers.get("persisted-id") is not None
    assert reloaded_b.papers.get("persisted-id") is None


# ── isolation: ScopedObjectStore ─────────────────────────────────────────────

def test_objects_are_isolated_between_user_spaces(registry: SpaceRegistry) -> None:
    import io

    space_a = registry.get("alice")
    space_b = registry.get("bob")

    space_a.objects.put("papers/secret.pdf", io.BytesIO(b"alice-only-bytes"))

    assert space_a.objects.stat("papers/secret.pdf") is not None
    assert space_b.objects.stat("papers/secret.pdf") is None
    with pytest.raises(FileNotFoundError):
        space_b.objects.open("papers/secret.pdf")

    # Guessing alice's user id from bob's own scope must still fail — bob's
    # ScopedObjectStore has no way to address alice's prefix at all.
    with pytest.raises(PermissionError):
        space_b.objects.open("../alice/papers/secret.pdf")


# ── isolation: VectorStore collections ───────────────────────────────────────

def test_vector_stores_use_distinct_collections_per_user(
    registry: SpaceRegistry,
) -> None:
    space_a = registry.get("alice")
    space_b = registry.get("bob")

    space_a.vstore.upsert_paper_vector(
        "paper-1", [0.1, 0.2, 0.3], {"title": "Alice's paper"}
    )

    assert space_a.vstore.paper_exists("paper-1") is True
    assert space_b.vstore.paper_exists("paper-1") is False
    assert space_a.vstore.count_papers() == 1
    assert space_b.vstore.count_papers() == 0


# ── current_space dependency ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_current_space_resolves_current_user_to_their_space(
    tmp_dbs: Path,
) -> None:
    from backend.auth import service as auth_service
    from backend.auth.db import get_engine, init_db
    from backend.auth.security import hash_password
    from backend.auth.models import User
    from backend.config import settings
    from backend.space import SpaceRegistry as _SR, current_space
    from sqlmodel import Session

    init_db()
    with Session(get_engine()) as db:
        user = User(
            id="userid123",
            handle="tester",
            display_name="Tester",
            password_hash=hash_password("irrelevant-password-1"),
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    client = VectorStore.build_client(settings.chroma_persist_dir)
    object_store = LocalObjectStore(settings.objects_dir)
    reg = _SR(
        chroma_client=client,
        object_store=object_store,
        ocr_svc=OCRService(),
        embed_svc=EmbeddingService(),
    )

    space = await current_space(user=user, registry=reg)
    assert space.user_id == "userid123"
    assert space is reg.get("userid123")
