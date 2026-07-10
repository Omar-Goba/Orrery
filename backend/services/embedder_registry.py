from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from backend.config import RoleConfig


IDENTITY_FILENAME = "embedder_identity.json"


@dataclass(frozen=True)
class EmbedderIdentity:
    base_url: str
    model: str
    dim: int
    recorded_at: str
    active_persist_dir: str | None = None

    @classmethod
    def current(
        cls,
        role: RoleConfig,
        dim: int,
        *,
        active_persist_dir: Path | None = None,
    ) -> "EmbedderIdentity":
        return cls(
            base_url=role.base_url,
            model=role.model,
            dim=dim,
            recorded_at=datetime.now(timezone.utc).isoformat(),
            active_persist_dir=str(active_persist_dir) if active_persist_dir else None,
        )

    def same_embedder(self, other: "EmbedderIdentity") -> bool:
        return self.base_url == other.base_url and self.model == other.model

    def with_active_persist_dir(self, path: Path) -> "EmbedderIdentity":
        return EmbedderIdentity(
            base_url=self.base_url,
            model=self.model,
            dim=self.dim,
            recorded_at=datetime.now(timezone.utc).isoformat(),
            active_persist_dir=str(path),
        )

    def active_path(self, fallback: Path) -> Path:
        return Path(self.active_persist_dir) if self.active_persist_dir else fallback


def identity_path(chroma_persist_dir: Path) -> Path:
    return chroma_persist_dir.parent / IDENTITY_FILENAME


def load_embedder_identity(chroma_persist_dir: Path) -> EmbedderIdentity | None:
    path = identity_path(chroma_persist_dir)
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    return EmbedderIdentity(
        base_url=data["base_url"],
        model=data["model"],
        dim=int(data["dim"]),
        recorded_at=data["recorded_at"],
        active_persist_dir=data.get("active_persist_dir"),
    )


def save_embedder_identity(
    chroma_persist_dir: Path,
    identity: EmbedderIdentity,
) -> Path:
    path = identity_path(chroma_persist_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(identity), indent=2, sort_keys=True) + "\n")
    return path
