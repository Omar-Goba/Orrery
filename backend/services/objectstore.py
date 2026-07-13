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
from typing import TYPE_CHECKING, Any, BinaryIO, Protocol, runtime_checkable

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from loguru import logger
from pydantic import BaseModel

if TYPE_CHECKING:
    from backend.config import Settings

_CHUNK_SIZE = 1024 * 1024  # 1 MiB
_MULTIPART_CHUNK_SIZE = 8 * 1024 * 1024
_NOT_FOUND_CODES = frozenset({"404", "NoSuchKey", "NotFound"})


def _read_chunk(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


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


def _validate_prefix(prefix: str) -> None:
    if prefix == "":
        return
    if prefix != prefix.strip() or prefix.startswith(("/", "\\")):
        raise InvalidKeyError(prefix)
    if "\\" in prefix or ":" in prefix:
        raise InvalidKeyError(prefix)
    segments = prefix.split("/")
    if any(segment in ("", ".", "..") for segment in segments[:-1]):
        raise InvalidKeyError(prefix)
    if segments[-1] in (".", ".."):
        raise InvalidKeyError(prefix)


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
        _validate_prefix(prefix)

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


class S3ObjectStore:
    """S3-compatible implementation of the synchronous ObjectStore protocol."""

    def __init__(self, bucket: str, client: Any) -> None:
        if not bucket.strip():
            raise ValueError("S3 bucket must be non-empty")
        self._bucket = bucket
        self._client = client

    @staticmethod
    def _is_not_found(exc: ClientError) -> bool:
        return str(exc.response.get("Error", {}).get("Code", "")) in _NOT_FOUND_CODES

    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int:
        _validate_key(key)
        if max_bytes is not None and max_bytes < 0:
            raise ValueError("max_bytes must be non-negative")

        first = _read_chunk(stream, _MULTIPART_CHUNK_SIZE)
        written = len(first)
        if max_bytes is not None and written > max_bytes:
            raise ObjectSizeLimitExceeded(key, max_bytes)

        second = _read_chunk(stream, _MULTIPART_CHUNK_SIZE)
        if not second:
            self._client.put_object(Bucket=self._bucket, Key=key, Body=first)
            return written

        upload_id: str | None = None
        try:
            response = self._client.create_multipart_upload(
                Bucket=self._bucket, Key=key
            )
            upload_id = response["UploadId"]
            parts: list[dict[str, Any]] = []
            part_number = 1
            chunk = first
            while True:
                response = self._client.upload_part(
                    Bucket=self._bucket,
                    Key=key,
                    UploadId=upload_id,
                    PartNumber=part_number,
                    Body=chunk,
                )
                parts.append({"ETag": response["ETag"], "PartNumber": part_number})
                part_number += 1
                chunk = second
                written += len(chunk)
                if max_bytes is not None and written > max_bytes:
                    raise ObjectSizeLimitExceeded(key, max_bytes)
                second = _read_chunk(stream, _MULTIPART_CHUNK_SIZE)
                if not second:
                    response = self._client.upload_part(
                        Bucket=self._bucket,
                        Key=key,
                        UploadId=upload_id,
                        PartNumber=part_number,
                        Body=chunk,
                    )
                    parts.append(
                        {"ETag": response["ETag"], "PartNumber": part_number}
                    )
                    break
            self._client.complete_multipart_upload(
                Bucket=self._bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={"Parts": parts},
            )
            upload_id = None
            return written
        except BaseException:
            if upload_id is not None:
                try:
                    self._client.abort_multipart_upload(
                        Bucket=self._bucket, Key=key, UploadId=upload_id
                    )
                except Exception:
                    logger.warning(
                        "Failed to abort incomplete S3 multipart upload; "
                        "manual cleanup may be required"
                    )
            raise

    def open(self, key: str) -> BinaryIO:
        _validate_key(key)
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if self._is_not_found(exc):
                raise FileNotFoundError(key) from exc
            raise
        return response["Body"]

    def delete(self, key: str) -> None:
        _validate_key(key)
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def stat(self, key: str) -> ObjectStat | None:
        _validate_key(key)
        try:
            response = self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if self._is_not_found(exc):
                return None
            raise
        return ObjectStat(
            key=key,
            size_bytes=response["ContentLength"],
            modified_at=response["LastModified"],
        )

    def list(self, prefix: str) -> list[ObjectStat]:
        _validate_prefix(prefix)
        paginator = self._client.get_paginator("list_objects_v2")
        results = [
            ObjectStat(
                key=item["Key"],
                size_bytes=item["Size"],
                modified_at=item["LastModified"],
            )
            for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix)
            for item in page.get("Contents", [])
        ]
        results.sort(key=lambda item: item.key)
        return results

    def check_ready(self) -> None:
        try:
            self._client.head_bucket(Bucket=self._bucket)
        except Exception as exc:
            raise RuntimeError("S3 object store readiness check failed") from exc


def create_object_store(configured: "Settings") -> ObjectStore:
    if configured.object_store == "local":
        return LocalObjectStore(configured.objects_dir)
    if configured.object_store != "s3":
        raise ValueError(f"unsupported object store: {configured.object_store!r}")

    client = boto3.client(
        "s3",
        endpoint_url=configured.s3_endpoint_url or None,
        region_name=configured.s3_region,
        aws_access_key_id=configured.s3_access_key_id.get_secret_value(),
        aws_secret_access_key=configured.s3_secret_access_key.get_secret_value(),
        config=Config(s3={"addressing_style": configured.s3_addressing_style}),
    )
    return S3ObjectStore(configured.s3_bucket, client)


def check_object_store_ready(store: ObjectStore) -> None:
    check_ready = getattr(store, "check_ready", None)
    if check_ready is not None:
        check_ready()


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
        if prefix == "":
            scoped_prefix = f"{self._prefix}/"
        else:
            scoped_prefix = self._key(prefix)
            if prefix.endswith("/"):
                scoped_prefix += "/"
        results = self._inner.list(scoped_prefix)
        return [
            ObjectStat(
                key=self._strip_prefix(r.key),
                size_bytes=r.size_bytes,
                modified_at=r.modified_at,
            )
            for r in results
        ]
