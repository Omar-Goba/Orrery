"""Password hashing and session-token primitives.

argon2id for passwords (argon2-cffi, not passlib). Session tokens are 256-bit
random values; only their sha256 hash is ever persisted, so a leaked DB does
not yield live sessions.
"""
from __future__ import annotations

import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHash

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHash):
        return False


def generate_session_token() -> str:
    """256 bits of randomness, URL-safe encoded."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
