from __future__ import annotations

from pathlib import Path

from backend.config import RoleConfig
from backend.services.embedder_registry import (
    EmbedderIdentity,
    identity_path,
    load_embedder_identity,
    save_embedder_identity,
)


def test_embedder_identity_round_trips_sidecar(tmp_path: Path) -> None:
    chroma_dir = tmp_path / "dbs" / "chroma"
    identity = EmbedderIdentity.current(
        RoleConfig(base_url="http://embedder/v1", model="paper-stars"),
        42,
        active_persist_dir=chroma_dir,
    )

    path = save_embedder_identity(chroma_dir, identity)

    assert path == identity_path(chroma_dir)
    assert load_embedder_identity(chroma_dir) == identity


def test_embedder_identity_compares_provider_and_model_only() -> None:
    old = EmbedderIdentity("http://a", "m", 3, "then")
    same = EmbedderIdentity("http://a", "m", 4, "now")
    changed = EmbedderIdentity("http://a", "other", 3, "now")

    assert old.same_embedder(same) is True
    assert old.same_embedder(changed) is False
