"""Unit tests for `LocalObjectStore` (plan §10.1).

Each rule in the plan's numbered list gets its own assertion here:
1. No code outside this class constructs a filesystem path to a PDF — we
   can't test a negative like that directly, but the escape-hardening tests
   below prove the class itself never lets a caller "compute" a path that
   lands outside the store root.
2. Keys are POSIX, relative, S3-legal.
3. Reads are streams, never a raw filesystem path handed back to a caller.
4. `put()` enforces `max_bytes` *during* streaming and leaves no partial
   object behind when aborted.
5. No symlinks, no `rglob`-style directory-tree semantics; `list(prefix)`
   is a flat prefix match.
6. Path-escape hardening: `..` or an out-of-root key raises, never
   silently normalizes.
"""
from __future__ import annotations

import io
from pathlib import Path

import pytest

from backend.services.objectstore import (
    InvalidKeyError,
    LocalObjectStore,
    ObjectSizeLimitExceeded,
)


@pytest.fixture()
def store(tmp_path: Path) -> LocalObjectStore:
    return LocalObjectStore(tmp_path / "objects")


# ── basic put/open/stat/delete round trip ───────────────────────────────────

def test_put_open_roundtrip(store: LocalObjectStore) -> None:
    data = b"%PDF-1.4 hello world"
    written = store.put("papers/abc123.pdf", io.BytesIO(data))
    assert written == len(data)

    with store.open("papers/abc123.pdf") as f:
        assert f.read() == data

    stat = store.stat("papers/abc123.pdf")
    assert stat is not None
    assert stat.key == "papers/abc123.pdf"
    assert stat.size_bytes == len(data)


def test_stat_missing_key_returns_none(store: LocalObjectStore) -> None:
    assert store.stat("papers/does-not-exist.pdf") is None


def test_open_missing_key_raises_file_not_found(store: LocalObjectStore) -> None:
    with pytest.raises(FileNotFoundError):
        store.open("papers/does-not-exist.pdf")


def test_delete_is_idempotent(store: LocalObjectStore) -> None:
    store.put("papers/x.pdf", io.BytesIO(b"data"))
    store.delete("papers/x.pdf")
    assert store.stat("papers/x.pdf") is None
    store.delete("papers/x.pdf")  # deleting again must not raise


# ── rule 3: never hand back a raw filesystem path ───────────────────────────

def test_open_returns_a_stream_not_a_path(store: LocalObjectStore) -> None:
    store.put("papers/y.pdf", io.BytesIO(b"stream-me"))
    handle = store.open("papers/y.pdf")
    try:
        assert hasattr(handle, "read")
        assert not isinstance(handle, (str, Path))
    finally:
        handle.close()


# ── rule 4: max_bytes enforced mid-stream, no partial object left behind ────

def test_put_aborts_mid_stream_when_max_bytes_exceeded(store: LocalObjectStore) -> None:
    data = b"x" * (5 * 1024 * 1024)  # bigger than the chunk size internally
    with pytest.raises(ObjectSizeLimitExceeded):
        store.put("papers/toobig.pdf", io.BytesIO(data), max_bytes=1024)

    # No partial object anywhere under the root.
    assert store.stat("papers/toobig.pdf") is None
    assert store.list("papers/") == []


def test_put_within_max_bytes_succeeds(store: LocalObjectStore) -> None:
    data = b"y" * 2048
    written = store.put("papers/ok.pdf", io.BytesIO(data), max_bytes=4096)
    assert written == len(data)
    assert store.stat("papers/ok.pdf") is not None


def test_put_exactly_at_max_bytes_succeeds(store: LocalObjectStore) -> None:
    data = b"z" * 4096
    written = store.put("papers/exact.pdf", io.BytesIO(data), max_bytes=4096)
    assert written == 4096


# ── rule 6: path-escape hardening ───────────────────────────────────────────

@pytest.mark.parametrize(
    "bad_key",
    [
        "../escape.pdf",
        "papers/../../escape.pdf",
        "papers/../escape.pdf",
        "/etc/passwd",
        "papers//../../etc/passwd",
        "",
        "   ",
        "papers/./x.pdf",
        "a\\..\\..\\escape.pdf",
        "C:/evil.pdf",
    ],
)
def test_escape_attempts_raise_on_put(store: LocalObjectStore, bad_key: str) -> None:
    with pytest.raises(InvalidKeyError):
        store.put(bad_key, io.BytesIO(b"data"))


@pytest.mark.parametrize("bad_key", ["../escape.pdf", "/etc/passwd", "papers/../x"])
def test_escape_attempts_raise_on_open(store: LocalObjectStore, bad_key: str) -> None:
    with pytest.raises(InvalidKeyError):
        store.open(bad_key)


@pytest.mark.parametrize("bad_key", ["../escape.pdf", "/etc/passwd"])
def test_escape_attempts_raise_on_stat_delete_list(
    store: LocalObjectStore, bad_key: str
) -> None:
    with pytest.raises(InvalidKeyError):
        store.stat(bad_key)
    with pytest.raises(InvalidKeyError):
        store.delete(bad_key)


def test_escape_does_not_silently_normalize_into_the_root(
    tmp_path: Path, store: LocalObjectStore
) -> None:
    """A key that *would* resolve outside root if naively joined must raise,
    not get clamped back into some "safe" path inside the root."""
    outside = tmp_path / "outside-canary.txt"
    with pytest.raises(InvalidKeyError):
        store.put("../outside-canary.txt", io.BytesIO(b"leak"))
    assert not outside.exists()


# ── rule 5: list(prefix) is a flat stat list, no directory semantics ────────

def test_list_returns_flat_stats_under_prefix(store: LocalObjectStore) -> None:
    store.put("papers/a.pdf", io.BytesIO(b"1"))
    store.put("papers/b.pdf", io.BytesIO(b"22"))
    store.put("other/c.pdf", io.BytesIO(b"333"))

    results = store.list("papers/")
    keys = sorted(r.key for r in results)
    assert keys == ["papers/a.pdf", "papers/b.pdf"]
    assert all(r.size_bytes > 0 for r in results)


def test_list_empty_prefix_returns_everything(store: LocalObjectStore) -> None:
    store.put("papers/a.pdf", io.BytesIO(b"1"))
    store.put("other/c.pdf", io.BytesIO(b"333"))
    results = store.list("")
    assert {r.key for r in results} == {"papers/a.pdf", "other/c.pdf"}


def test_list_no_rglob_in_implementation() -> None:
    """No directory-tree semantics against objects (plan §10.1 rule #5) —
    pinned at the source level so a future edit doesn't quietly reintroduce
    `Path.rglob` (which implies symlink-following directory-walk semantics)
    into the one class that's supposed to not have any."""
    import inspect

    source = inspect.getsource(LocalObjectStore)
    assert "rglob" not in source
    assert "os.symlink" not in source


def test_list_rejects_traversal_in_prefix(store: LocalObjectStore) -> None:
    with pytest.raises(InvalidKeyError):
        store.list("papers/../../etc")
