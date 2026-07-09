"""Shared in-memory paper registry backed by dbs/papers.json."""
from __future__ import annotations
import hashlib
import json
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
    def __init__(self) -> None:
        self._records: dict[str, PaperRecord] = {}

    def load(self) -> None:
        p = settings.papers_json
        if p.exists():
            raw = json.loads(p.read_text())
            self._records = {k: PaperRecord(**v) for k, v in raw.items()}

    def save(self) -> None:
        settings.papers_json.parent.mkdir(parents=True, exist_ok=True)
        tmp = settings.papers_json.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {k: v.model_dump(mode="json") for k, v in self._records.items()},
                indent=2,
            )
        )
        tmp.replace(settings.papers_json)

    def get(self, paper_id: str) -> PaperRecord | None:
        return self._records.get(paper_id)

    def put(self, record: PaperRecord) -> None:
        self._records[record.id] = record

    def all(self) -> list[PaperRecord]:
        return list(self._records.values())

    def items(self) -> Iterator[tuple[str, PaperRecord]]:
        return self._records.items()

    def as_dict(self) -> dict[str, PaperRecord]:
        return dict(self._records)

    def __len__(self) -> int:
        return len(self._records)


paper_store = PaperStore()
