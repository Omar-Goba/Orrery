"""In-memory paper registry backed by a JSON file (plan §4.1/§4.4).

Pre-multiuser, there was exactly one `PaperStore` (the module-level
`paper_store` below) pointed at `settings.papers_json`. Every `UserSpace` now
gets its own instance, pointed at `settings.user_papers_json(user_id)`.
`PaperStore.__init__` takes an optional path so both cases share one class; the
module-level singleton remains only for legacy migration/tooling code.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
from pathlib import Path
from typing import Iterator

from backend.config import settings
from backend.models import PaperRecord


def paper_id_for_bytes(data: bytes) -> str:
    """Content-addressed paper id (plan §4.3).

    Replaces the old path-hash `paper_id_for` — identity now comes from the
    PDF's bytes, not the path it happened to land at. Re-uploading identical
    content always yields the same id, which is what makes dedup possible.
    Callers that stream a large upload should hash incrementally with their
    own `hashlib.sha256()` and only call `.hexdigest()[:16]` at the end
    rather than buffering the whole file to pass here.
    """
    return hashlib.sha256(data).hexdigest()[:16]


class PaperStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path: Path = Path(path) if path is not None else settings.papers_json
        self._records: dict[str, PaperRecord] = {}
        # Per-instance lock (plan §4.4 concurrency note): serializes save()
        # so concurrent callers can't interleave two `_write` calls and tear
        # the file. Good enough for tens of users; SQLite migration is the
        # escape hatch if that assumption breaks.
        self._lock = asyncio.Lock()

    def load(self) -> None:
        if self._path.exists():
            raw = json.loads(self._path.read_text())
            self._records = {k: PaperRecord(**v) for k, v in raw.items()}

    async def save(self) -> None:
        async with self._lock:
            await asyncio.to_thread(self._write)

    def _write(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {k: v.model_dump(mode="json") for k, v in self._records.items()},
                indent=2,
            )
        )
        tmp.replace(self._path)

    def get(self, paper_id: str) -> PaperRecord | None:
        return self._records.get(paper_id)

    def put(self, record: PaperRecord) -> None:
        self._records[record.id] = record

    def delete(self, paper_id: str) -> bool:
        return self._records.pop(paper_id, None) is not None

    def all(self) -> list[PaperRecord]:
        return list(self._records.values())

    def items(self) -> Iterator[tuple[str, PaperRecord]]:
        return self._records.items()

    def as_dict(self) -> dict[str, PaperRecord]:
        return dict(self._records)

    def __len__(self) -> int:
        return len(self._records)


paper_store = PaperStore()
