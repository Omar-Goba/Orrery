from __future__ import annotations

from pathlib import Path

import pytest

from backend.models import ChunkRecord
from backend.services.embedder_registry import EmbedderIdentity, load_embedder_identity
from backend.services.objectstore import LocalObjectStore
from backend.services.ocr import OCRService
from backend.services.reembed_job import REEMBED_PROGRESS, ReembedJob
from backend.services.vectorstore import VectorStore
from backend.space import SpaceRegistry


class FakeEmbeddingService:
    dim = 2

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(text)), 1.0] for text in texts]

    def paper_vector(self, chunk_vectors: list[list[float]], *, dim: int | None = None) -> list[float]:
        if not chunk_vectors:
            return [0.0] * (dim or self.dim)
        total = [sum(values) for values in zip(*chunk_vectors)]
        return [value / len(chunk_vectors) for value in total]


def _job(tmp_dbs: Path, old_client, registry: SpaceRegistry) -> ReembedJob:
    from backend.config import settings

    return ReembedJob(
        registry=registry,
        old_client=old_client,
        old_persist_dir=settings.chroma_persist_dir,
        embed_svc=FakeEmbeddingService(),  # type: ignore[arg-type]
        new_identity=EmbedderIdentity("http://new", "new-model", 2, "now"),
        chroma_persist_dir=settings.chroma_persist_dir,
    )


def _seed(store: VectorStore, paper_id: str, text: str) -> None:
    store.add_chunks(
        paper_id,
        [ChunkRecord(paper_id=paper_id, chunk_index=0, text=text, token_count=1)],
        [[0.1, 0.2]],
    )
    store.upsert_paper_vector(paper_id, [0.1, 0.2], {"title": paper_id})


@pytest.fixture()
def registry_and_client(tmp_dbs: Path):
    from backend.config import settings

    old_client = VectorStore.build_client(settings.chroma_persist_dir)
    registry = SpaceRegistry(
        chroma_client=old_client,
        object_store=LocalObjectStore(settings.objects_dir),
        ocr_svc=OCRService(),
        embed_svc=FakeEmbeddingService(),  # type: ignore[arg-type]
    )
    settings.user_dir("user-a").mkdir(parents=True)
    return registry, old_client


@pytest.mark.asyncio
async def test_reembed_copy_user_skips_existing_resume(
    tmp_dbs: Path,
    registry_and_client,
) -> None:
    from backend.config import settings

    registry, old_client = registry_and_client
    old_store = VectorStore(old_client, user_id="user-a")
    _seed(old_store, "paper-1", "old text")

    new_client = VectorStore.build_client(settings.chroma_persist_dir.parent / "chroma_new")
    new_store = VectorStore(new_client, user_id="user-a")
    _seed(new_store, "paper-1", "already copied")

    copied = await _job(tmp_dbs, old_client, registry)._copy_user(
        "user-a",
        new_client,
        skip_existing=True,
        count_total=True,
    )

    assert copied == 0
    assert REEMBED_PROGRESS["total_papers"] >= 1
    assert new_store.get_paper_metadata("paper-1")["title"] == "paper-1"  # type: ignore[index]


@pytest.mark.asyncio
async def test_reembed_run_final_diff_swaps_and_saves_identity(
    tmp_dbs: Path,
    registry_and_client,
) -> None:
    from backend.config import settings

    registry, old_client = registry_and_client
    old_store = VectorStore(old_client, user_id="user-a")
    _seed(old_store, "paper-1", "first")

    job = _job(tmp_dbs, old_client, registry)

    original_copy_user = job._copy_user

    async def copy_user_with_late_ingest(*args, **kwargs):
        copied = await original_copy_user(*args, **kwargs)
        if kwargs.get("count_total") is True and not old_store.paper_exists("paper-2"):
            _seed(old_store, "paper-2", "late")
        return copied

    job._copy_user = copy_user_with_late_ingest  # type: ignore[method-assign]
    await job.run()

    assert REEMBED_PROGRESS["status"] == "done"
    swapped = registry.get("user-a")
    assert swapped.vstore.paper_exists("paper-1") is True
    assert swapped.vstore.paper_exists("paper-2") is True
    assert load_embedder_identity(settings.chroma_persist_dir).model == "new-model"  # type: ignore[union-attr]
    assert (settings.chroma_persist_dir.parent / "chroma_old").exists()
