"""Unit tests for handle validation, password hashing, and session primitives."""
from __future__ import annotations

from datetime import timedelta

import pytest

from backend.auth.models import HANDLE_RE, AuthSession, User, utcnow
from backend.auth.security import (
    generate_session_token,
    hash_password,
    hash_token,
    verify_password,
)
from backend.auth.service import (
    RESERVED_HANDLES,
    AuthError,
    create_session,
    get_user_for_token,
    revoke_session,
    validate_handle,
    validate_password,
)


# ── handle validation ──────────────────────────────────────────────────────

@pytest.mark.parametrize("reserved", sorted(RESERVED_HANDLES))
def test_reserved_handles_rejected(reserved: str) -> None:
    with pytest.raises(AuthError):
        validate_handle(reserved)


@pytest.mark.parametrize(
    "handle",
    ["ab", "AB", "-abc", "has space", "toolonghandle1234567890123456", "a!b"],
)
def test_invalid_handles_rejected(handle: str) -> None:
    with pytest.raises(AuthError):
        validate_handle(handle)


@pytest.mark.parametrize(
    "handle", ["abc", "voyager1", "a.b-c_d", "z9z", "researcher-42"]
)
def test_valid_handles_accepted(handle: str) -> None:
    assert validate_handle(handle) == handle.lower()


def test_handle_case_sensitivity_is_normalized_to_lowercase() -> None:
    assert validate_handle("MyHandle") == "myhandle"
    assert HANDLE_RE.match("myhandle")
    assert not HANDLE_RE.match("MyHandle")


def test_password_min_length() -> None:
    with pytest.raises(AuthError):
        validate_password("short1234")  # 9 chars
    validate_password("longenough1")  # 11 chars, should not raise


# ── argon2 hashing ─────────────────────────────────────────────────────────

def test_password_hash_roundtrip() -> None:
    password = "correct horse battery staple"
    hashed = hash_password(password)
    assert hashed != password
    assert verify_password(password, hashed) is True
    assert verify_password("wrong password entirely", hashed) is False


def test_password_hash_is_never_plaintext() -> None:
    password = "supersecretpassword123"
    hashed = hash_password(password)
    assert password not in hashed


# ── session tokens ─────────────────────────────────────────────────────────

def test_session_tokens_are_unique() -> None:
    tokens = {generate_session_token() for _ in range(50)}
    assert len(tokens) == 50


def test_token_hash_is_not_the_raw_token() -> None:
    token = generate_session_token()
    hashed = hash_token(token)
    assert hashed != token
    # sha256 hex digest is 64 chars
    assert len(hashed) == 64


# ── session expiry / revocation (needs a DB session) ───────────────────────

def _make_user(db_session) -> User:
    user = User(
        id="testuser1",
        handle="testuser",
        display_name="Test User",
        password_hash=hash_password("irrelevant-password"),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def test_expired_session_is_rejected(db_session) -> None:
    user = _make_user(db_session)
    token = "raw-token-value"
    now = utcnow()
    expired = AuthSession(
        token_hash=hash_token(token),
        user_id=user.id,
        created_at=now - timedelta(days=31),
        expires_at=now - timedelta(days=1),  # already expired
        last_seen_at=now - timedelta(days=31),
    )
    db_session.add(expired)
    db_session.commit()

    assert get_user_for_token(db_session, token) is None


def test_valid_session_resolves_to_user(db_session) -> None:
    user = _make_user(db_session)
    token = create_session(db_session, user)
    resolved = get_user_for_token(db_session, token)
    assert resolved is not None
    assert resolved.id == user.id


def test_logout_revokes_session_immediately(db_session) -> None:
    user = _make_user(db_session)
    token = create_session(db_session, user)
    assert get_user_for_token(db_session, token) is not None

    revoke_session(db_session, token)

    assert get_user_for_token(db_session, token) is None
