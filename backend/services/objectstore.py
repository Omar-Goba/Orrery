"""The `ObjectStore` seam (plan §10.1).

This module is the *only* place in the codebase allowed to construct a
filesystem path to a stored PDF (or any other object byte blob). Every other
call site — upload, file-serving, ingest, reindex — goes through the five
methods on `ObjectStore`. That's what makes a future MinIO/S3 backend a new
class + a config flag instead of a second refactor.

Keys are POSIX, relative, S3-legal strings, e.g. `papers/{paper_id}.pdf`.
Per-user prefixing (`users/{user_id}/papers/{paper_id}.pdf`) is Phase 3's
job via a `ScopedObjectStore` wrapper — this store doesn't know about users.
"""
from __future__ import annotations

import os
import posixpath
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol, runtime_checkable

from pydantic import BaseModel

_CHUNK_SIZE = 1024 * 1024  # 1 MiB


class ObjectStat(BaseModel):
    key: str
    size_bytes: int
    modified_at: datetime


class ObjectStoreError(Exception):
    """Base class for object-store key/IO violations."""


class InvalidKeyError(ObjectStoreError):
    """Raised when a key is not a legal, in-bounds, POSIX-relative key.

    This must be raised, never silently normalized — a key that tries to
    escape the store root (`..`, absolute paths, backslashes) is a bug or an
    attack, not something to politely clamp back into bounds.
    """


class ObjectSizeLimitExceeded(ObjectStoreError):
    """Raised mid-stream from `put()` when `max_bytes` is exceeded.

    By the time this is raised, any partial write has already been cleaned
    up — callers never see a truncated object on disk.
    """

    def __init__(self, key: str, max_bytes: int) -> None:
        super().__init__(f"object {key!r} exceeded max_bytes={max_bytes}")
        self.key = key
        self.max_bytes = max_bytes


@runtime_checkable
class ObjectStore(Protocol):
    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int: ...

    def open(self, key: str) -> BinaryIO: ...

    def delete(self, key: str) -> None: ...

    def stat(self, key: str) -> ObjectStat | None: ...

    def list(self, prefix: str) -> list[ObjectStat]: ...


def _validate_key(key: str) -> None:
    """Reject anything that isn't a plain, relative, POSIX-shaped key.

    Deliberately conservative: no leading slash, no backslashes, no empty
    segments, no `.` / `..` segments anywhere. Rule #6/§10.1: a key that
    would escape the store root must raise, never get silently normalized
    into something "safe."
    """
    if not key or not key.strip():
        raise InvalidKeyError(key)
    if key != key.strip():
        raise InvalidKeyError(key)
    if key.startswith("/") or key.startswith("\\"):
        raise InvalidKeyError(key)
    if "\\" in key:
        raise InvalidKeyError(key)
    if ":" in key:  # windows drive letters, e.g. "C:/evil"
        raise InvalidKeyError(key)
    segments = key.split("/")
    if any(seg in ("", ".", "..") for seg in segments):
        raise InvalidKeyError(key)


class LocalObjectStore:
    """Maps key -> {root}/{key} on local disk.

    The only class that touches PDF (or any object) filesystem paths.
    """

    def __init__(self, root: Path) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    # ── key resolution ───────────────────────────────────────────────────

    def _resolve(self, key: str) -> Path:
        _validate_key(key)
        candidate = (self._root / key).resolve()
        # Belt-and-suspenders: even a validated key must resolve inside the
        # root once symlinks/`..` collapse. If it doesn't, raise — never
        # silently clamp back into the root.
        try:
            candidate.relative_to(self._root)
        except ValueError:
            raise InvalidKeyError(key) from None
        return candidate

    # ── ObjectStore API ──────────────────────────────────────────────────

    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int:
        dest = self._resolve(key)
        dest.parent.mkdir(parents=True, exist_ok=True)

        fd, tmp_name = tempfile.mkstemp(
            dir=str(dest.parent), prefix=".tmp-", suffix=".part"
        )
        tmp_path = Path(tmp_name)
        written = 0
        try:
            with os.fdopen(fd, "wb") as out:
                while True:
                    chunk = stream.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    written += len(chunk)
                    if max_bytes is not None and written > max_bytes:
                        raise ObjectSizeLimitExceeded(key, max_bytes)
                    out.write(chunk)
            tmp_path.replace(dest)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
        return written

    def open(self, key: str) -> BinaryIO:
        path = self._resolve(key)
        if not path.is_file():
            raise FileNotFoundError(key)
        return open(path, "rb")

    def delete(self, key: str) -> None:
        path = self._resolve(key)
        path.unlink(missing_ok=True)

    def stat(self, key: str) -> ObjectStat | None:
        path = self._resolve(key)
        if not path.is_file():
            return None
        st = path.stat()
        return ObjectStat(
            key=key,
            size_bytes=st.st_size,
            modified_at=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
        )

    def list(self, prefix: str) -> list[ObjectStat]:
        """Flat stat list of every object whose key starts with `prefix`.

        No directory-tree semantics: `prefix` is a string prefix on the key,
        not a directory that must exist. Deliberately walks the root with
        plain `os.walk` rather than pydoc's tree-globbing helpers (rule #5)
        — objects have no symlink/directory meaning of their own.
        """
        if prefix:
            segments = prefix.split("/")
            if any(seg in (".", "..") for seg in segments if seg != segments[-1]):
                raise InvalidKeyError(prefix)

        results: list[ObjectStat] = []
        for dirpath, _dirnames, filenames in os.walk(self._root):
            for name in filenames:
                full = Path(dirpath) / name
                rel = full.relative_to(self._root).as_posix()
                if rel.startswith(prefix):
                    st = full.stat()
                    results.append(
                        ObjectStat(
                            key=rel,
                            size_bytes=st.st_size,
                            modified_at=datetime.fromtimestamp(
                                st.st_mtime, tz=timezone.utc
                            ),
                        )
                    )
        results.sort(key=lambda o: o.key)
        return results


class ScopedObjectStore:
    """Prefix-locked view over a shared `ObjectStore` (plan §6.2).

    `UserSpace.objects` is always a `ScopedObjectStore` wrapping the one
    shared `LocalObjectStore`, locked to `users/{user_id}`. Handlers and
    agents only ever see relative keys like `papers/{paper_id}.pdf` — the
    prefix is invisible to them, which is what makes it safe to hand a
    `ScopedObjectStore` to code that already trusts a bare `ObjectStore`
    (`LibrarianAgent` et al. don't need to know they're scoped).

    This is defense in depth *on top of* `LocalObjectStore._resolve`'s own
    key validation (rule §10.1), not instead of it — even a buggy handler
    holding a hostile `rel` key cannot escape its prefix, and even a bug in
    this class can't escape the store root because the inner store still
    validates the final, prefixed key.

    Deliberately stricter than the plan's §6.2 code sketch: a naive
    `key.startswith(self._prefix)` check (no trailing separator) is exactly
    the classic prefix-spoofing bug — `users/abc` is a string-prefix of
    `users/abcevil`, so `../abcevil/x` would pass a bare `startswith` check
    even though it plainly targets a sibling user's namespace. This
    implementation rejects any `rel` containing `..` outright (so that
    attack never even reaches the `startswith` check) and additionally
    requires the resolved key to equal the prefix or start with
    `f"{prefix}/"` (with the separator), not just share a string prefix.
    """

    def __init__(self, inner: "ObjectStore", prefix: str) -> None:
        prefix = prefix.strip("/")
        if not prefix:
            raise ValueError("ScopedObjectStore prefix must be non-empty")
        _validate_key(prefix)
        self._inner = inner
        self._prefix = prefix

    def _key(self, rel: str, *, allow_empty: bool = False) -> str:
        if rel is None or (rel == "" and not allow_empty):
            raise PermissionError(rel)
        if rel == "":
            return self._prefix
        if rel.startswith("/") or rel.startswith("\\") or "\\" in rel or ".." in rel:
            raise PermissionError(rel)
        key = posixpath.normpath(f"{self._prefix}/{rel}")
        if key != self._prefix and not key.startswith(f"{self._prefix}/"):
            raise PermissionError(rel)
        return key

    def _strip_prefix(self, key: str) -> str:
        if key == self._prefix:
            return ""
        if key.startswith(f"{self._prefix}/"):
            return key[len(self._prefix) + 1 :]
        # Should be unreachable — `_key` guarantees every key it returns is
        # in-bounds — but never silently hand back a foreign key.
        raise PermissionError(key)

    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int:
        return self._inner.put(self._key(key), stream, max_bytes=max_bytes)

    def open(self, key: str) -> BinaryIO:
        return self._inner.open(self._key(key))

    def delete(self, key: str) -> None:
        self._inner.delete(self._key(key))

    def stat(self, key: str) -> ObjectStat | None:
        stat = self._inner.stat(self._key(key))
        if stat is None:
            return None
        return ObjectStat(
            key=self._strip_prefix(stat.key),
            size_bytes=stat.size_bytes,
            modified_at=stat.modified_at,
        )

    def list(self, prefix: str = "") -> list[ObjectStat]:
        scoped_prefix = self._key(prefix, allow_empty=True)
        results = self._inner.list(scoped_prefix)
        return [
            ObjectStat(
                key=self._strip_prefix(r.key),
                size_bytes=r.size_bytes,
                modified_at=r.modified_at,
            )
            for r in results
        ]
