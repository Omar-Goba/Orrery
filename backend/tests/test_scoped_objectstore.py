"""Unit tests for `ScopedObjectStore` (plan §6.2).

The PDF bytes are the crown jewels (plan §6): `ScopedObjectStore` is the
layer that makes it structurally impossible for a handler holding a
per-user-prefixed key to read or write outside its own `users/{user_id}/`
namespace, even if it's buggy or hostile. Every attack shape called out in
the plan (`../`, absolute keys, and the `users/{id}evil/` sibling-prefix
spoof) gets its own assertion here.
"""
from __future__ import annotations

import io
from pathlib import Path

import pytest

from backend.services.objectstore import LocalObjectStore, ScopedObjectStore


@pytest.fixture()
def inner(tmp_path: Path) -> LocalObjectStore:
    return LocalObjectStore(tmp_path / "objects")


@pytest.fixture()
def scoped_a(inner: LocalObjectStore) -> ScopedObjectStore:
    return ScopedObjectStore(inner, "users/alice")


@pytest.fixture()
def scoped_b(inner: LocalObjectStore) -> ScopedObjectStore:
    return ScopedObjectStore(inner, "users/bob")


# ── basic round trip stays inside the prefix ────────────────────────────────

def test_put_open_roundtrip_scoped(
    inner: LocalObjectStore, scoped_a: ScopedObjectStore
) -> None:
    data = b"%PDF-1.4 alice's paper"
    written = scoped_a.put("papers/p1.pdf", io.BytesIO(data))
    assert written == len(data)

    with scoped_a.open("papers/p1.pdf") as f:
        assert f.read() == data

    # The object really landed under the prefix on the inner store.
    assert inner.stat("users/alice/papers/p1.pdf") is not None
    assert inner.stat("papers/p1.pdf") is None


def test_stat_and_delete_scoped(scoped_a: ScopedObjectStore) -> None:
    scoped_a.put("papers/p2.pdf", io.BytesIO(b"data"))
    stat = scoped_a.stat("papers/p2.pdf")
    assert stat is not None
    assert stat.key == "papers/p2.pdf"  # relative to the scope, prefix stripped

    scoped_a.delete("papers/p2.pdf")
    assert scoped_a.stat("papers/p2.pdf") is None


def test_list_returns_keys_relative_to_scope(scoped_a: ScopedObjectStore) -> None:
    scoped_a.put("papers/a.pdf", io.BytesIO(b"1"))
    scoped_a.put("papers/b.pdf", io.BytesIO(b"22"))

    results = scoped_a.list("papers/")
    keys = sorted(r.key for r in results)
    assert keys == ["papers/a.pdf", "papers/b.pdf"]


def test_list_empty_prefix_lists_everything_in_scope(
    scoped_a: ScopedObjectStore,
) -> None:
    scoped_a.put("papers/a.pdf", io.BytesIO(b"1"))
    scoped_a.put("ocr_cache/x.json", io.BytesIO(b"2"))
    results = scoped_a.list("")
    assert {r.key for r in results} == {"papers/a.pdf", "ocr_cache/x.json"}


# ── cross-user isolation ─────────────────────────────────────────────────────

def test_two_scopes_over_the_same_inner_store_are_isolated(
    scoped_a: ScopedObjectStore, scoped_b: ScopedObjectStore
) -> None:
    scoped_a.put("papers/secret.pdf", io.BytesIO(b"alice-only"))

    assert scoped_a.stat("papers/secret.pdf") is not None
    assert scoped_b.stat("papers/secret.pdf") is None
    with pytest.raises(FileNotFoundError):
        scoped_b.open("papers/secret.pdf")

    assert scoped_b.list("") == []


# ── escape-attempt hardening (plan §13) ─────────────────────────────────────

ESCAPE_ATTEMPTS = [
    "../../other-user/x",
    "../bob/x",
    "../../../etc/passwd",
    "/etc/passwd",
    "/users/bob/papers/p1.pdf",
    "\\..\\..\\escape.pdf",
    # Sibling-prefix spoof: "users/alice" is a *string* prefix of
    # "users/aliceevil", so a naive `key.startswith(self._prefix)` check
    # (the plan §6.2 sketch, read literally) would let this through.
    "../aliceevil/x",
    "../alice-evil/x",
]


@pytest.mark.parametrize("bad_rel", ESCAPE_ATTEMPTS)
def test_escape_attempts_raise_on_put(
    scoped_a: ScopedObjectStore, bad_rel: str
) -> None:
    with pytest.raises(PermissionError):
        scoped_a.put(bad_rel, io.BytesIO(b"leak"))


@pytest.mark.parametrize("bad_rel", ESCAPE_ATTEMPTS)
def test_escape_attempts_raise_on_open(
    scoped_a: ScopedObjectStore, bad_rel: str
) -> None:
    with pytest.raises(PermissionError):
        scoped_a.open(bad_rel)


@pytest.mark.parametrize("bad_rel", ESCAPE_ATTEMPTS)
def test_escape_attempts_raise_on_delete_and_stat(
    scoped_a: ScopedObjectStore, bad_rel: str
) -> None:
    with pytest.raises(PermissionError):
        scoped_a.delete(bad_rel)
    with pytest.raises(PermissionError):
        scoped_a.stat(bad_rel)


@pytest.mark.parametrize("bad_rel", ESCAPE_ATTEMPTS)
def test_escape_attempts_raise_on_list(
    scoped_a: ScopedObjectStore, bad_rel: str
) -> None:
    with pytest.raises(PermissionError):
        scoped_a.list(bad_rel)


def test_sibling_prefix_spoof_never_reaches_the_sibling_object(
    inner: LocalObjectStore, scoped_a: ScopedObjectStore
) -> None:
    """Concretely prove the spoof doesn't just raise — it also never
    touches `users/aliceevil/...` on the inner store, even indirectly."""
    scoped_evil = ScopedObjectStore(inner, "users/aliceevil")
    scoped_evil.put("secret.pdf", io.BytesIO(b"evil-users-secret"))

    with pytest.raises(PermissionError):
        scoped_a.open("../aliceevil/secret.pdf")

    # The sibling's object is untouched and only reachable through its own
    # scope.
    assert scoped_evil.stat("secret.pdf") is not None


def test_empty_rel_key_rejected_on_put_open_delete_stat(
    scoped_a: ScopedObjectStore,
) -> None:
    with pytest.raises(PermissionError):
        scoped_a.put("", io.BytesIO(b"x"))
    with pytest.raises(PermissionError):
        scoped_a.open("")
    with pytest.raises(PermissionError):
        scoped_a.delete("")
    with pytest.raises(PermissionError):
        scoped_a.stat("")


def test_prefix_must_be_nonempty() -> None:
    from backend.services.objectstore import LocalObjectStore as _LOS

    with pytest.raises(ValueError):
        ScopedObjectStore(_LOS(Path("/tmp/whatever-unused")), "")
