"""`PaperStore.save()` concurrency (plan §4.4 concurrency note).

Pre-multiuser there was exactly one `PaperStore`, one caller at a time in
practice. Per-user `UserSpace`s change nothing about that *per instance*,
but the plan calls for a per-instance `asyncio.Lock` around `save()` as a
defensive measure ("good enough for tens of users"). `save()` now offloads
the actual write to a thread (`asyncio.to_thread`) so the lock has something
real to serialize — without that, a single-threaded event loop with no
`await` inside the write couldn't interleave two calls anyway, which would
make the lock untestable.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from backend.models import PaperRecord
from backend.store import PaperStore


def _record(paper_id: str, title: str) -> PaperRecord:
    return PaperRecord(
        id=paper_id,
        filename=f"{paper_id}.pdf",
        source_filename=f"{paper_id}.pdf",
        status="toread",
        title=title,
    )


@pytest.mark.asyncio
async def test_concurrent_saves_do_not_corrupt_the_file(tmp_path: Path) -> None:
    store = PaperStore(tmp_path / "papers.json")

    async def _save_with(title: str) -> None:
        store.put(_record("p1", title))
        await store.save()

    n = 25
    await asyncio.gather(*(_save_with(f"title-{i}") for i in range(n)))

    raw = (tmp_path / "papers.json").read_text()
    parsed = json.loads(raw)  # must not be torn/interleaved JSON
    assert set(parsed.keys()) == {"p1"}
    # Reflects *some* single write, not a mix of two.
    assert parsed["p1"]["title"].startswith("title-")


@pytest.mark.asyncio
async def test_concurrent_saves_from_distinct_stores_never_interleave_bytes(
    tmp_path: Path,
) -> None:
    """A stronger version: writers race to grow/shrink the record dict on
    the *same* store instance so a torn write would very likely produce
    invalid JSON (partial object from one write, tail from another)."""
    store = PaperStore(tmp_path / "papers.json")

    async def _grow_and_save(i: int) -> None:
        for j in range(5):
            store.put(_record(f"p{i}-{j}", f"paper {i}-{j}"))
        await store.save()

    await asyncio.gather(*(_grow_and_save(i) for i in range(10)))

    raw = (tmp_path / "papers.json").read_text()
    parsed = json.loads(raw)
    assert isinstance(parsed, dict)
    assert len(parsed) > 0


@pytest.mark.asyncio
async def test_save_is_serialized_not_concurrent(tmp_path: Path) -> None:
    """Directly prove the lock serializes: two `save()` calls launched
    concurrently must never both be "in flight" (past the lock) at once."""
    store = PaperStore(tmp_path / "papers.json")
    in_flight = 0
    max_in_flight = 0
    lock = asyncio.Lock()

    orig_write = store._write

    def _tracked_write() -> None:
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        orig_write()
        in_flight -= 1

    store._write = _tracked_write  # type: ignore[method-assign]

    await asyncio.gather(*(store.save() for _ in range(10)))

    assert max_in_flight == 1
