"""SQLModel tables for identity: users and sessions.

Schema per documentation/ORRERY_AUTH_PLAN.md §3.2. `dbs/orrery.db`, SQLite.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlmodel import Field, SQLModel

# ── roles ────────────────────────────────────────────────────────────────
# Always reference roles through these constants, never string literals.
ROLE_KEEPER = "keeper"
ROLE_VOYAGER = "voyager"

DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024  # overridden by settings.default_quota_bytes

HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,23}$")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    __tablename__ = "user"

    id: str = Field(primary_key=True)  # short uuid4 hex — NOT the handle
    handle: str = Field(unique=True, index=True)  # lowercase, HANDLE_RE
    display_name: str
    password_hash: str  # argon2id
    role: str = ROLE_VOYAGER  # "keeper" | "voyager"
    storage_quota_bytes: int = DEFAULT_QUOTA_BYTES
    storage_used_bytes: int = 0
    created_at: datetime = Field(default_factory=utcnow)
    disabled: bool = False


class AuthSession(SQLModel, table=True):
    __tablename__ = "authsession"

    token_hash: str = Field(primary_key=True)  # sha256 of the cookie token
    user_id: str = Field(index=True, foreign_key="user.id")
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime
    last_seen_at: datetime = Field(default_factory=utcnow)
