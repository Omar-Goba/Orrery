from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, select

from backend.auth.db import get_engine
from backend.auth.models import User


@dataclass(frozen=True)
class StorageSnapshot:
    used: int
    quota: int

    @property
    def remaining(self) -> int:
        return max(0, self.quota - self.used)


class QuotaExceeded(Exception):
    def __init__(self, snapshot: StorageSnapshot) -> None:
        super().__init__("quota exceeded")
        self.snapshot = snapshot


def get_storage_snapshot(user_id: str) -> StorageSnapshot:
    with Session(get_engine()) as db:
        user = db.get(User, user_id)
        if user is None:
            raise ValueError(f"unknown user_id={user_id!r}")
        return StorageSnapshot(
            used=user.storage_used_bytes,
            quota=user.storage_quota_bytes,
        )


def ensure_can_store(user_id: str, size_bytes: int) -> StorageSnapshot:
    snapshot = get_storage_snapshot(user_id)
    if size_bytes > snapshot.remaining:
        raise QuotaExceeded(snapshot)
    return snapshot


def increment_storage_used(user_id: str, delta_bytes: int) -> StorageSnapshot:
    if delta_bytes < 0:
        raise ValueError("delta_bytes must be non-negative")
    with Session(get_engine()) as db:
        user = db.get(User, user_id)
        if user is None:
            raise ValueError(f"unknown user_id={user_id!r}")
        if user.storage_used_bytes + delta_bytes > user.storage_quota_bytes:
            raise QuotaExceeded(
                StorageSnapshot(
                    used=user.storage_used_bytes,
                    quota=user.storage_quota_bytes,
                )
            )
        user.storage_used_bytes += delta_bytes
        db.add(user)
        db.commit()
        db.refresh(user)
        return StorageSnapshot(user.storage_used_bytes, user.storage_quota_bytes)


def decrement_storage_used(user_id: str, delta_bytes: int) -> StorageSnapshot:
    if delta_bytes < 0:
        raise ValueError("delta_bytes must be non-negative")
    with Session(get_engine()) as db:
        user = db.get(User, user_id)
        if user is None:
            raise ValueError(f"unknown user_id={user_id!r}")
        user.storage_used_bytes = max(0, user.storage_used_bytes - delta_bytes)
        db.add(user)
        db.commit()
        db.refresh(user)
        return StorageSnapshot(user.storage_used_bytes, user.storage_quota_bytes)


def set_storage_used(user_id: str, used_bytes: int) -> StorageSnapshot:
    if used_bytes < 0:
        raise ValueError("used_bytes must be non-negative")
    with Session(get_engine()) as db:
        user = db.get(User, user_id)
        if user is None:
            raise ValueError(f"unknown user_id={user_id!r}")
        user.storage_used_bytes = used_bytes
        db.add(user)
        db.commit()
        db.refresh(user)
        return StorageSnapshot(user.storage_used_bytes, user.storage_quota_bytes)


def list_voyager_users() -> list[User]:
    from backend.auth.models import ROLE_VOYAGER

    with Session(get_engine()) as db:
        return list(
            db.exec(select(User).where(User.role == ROLE_VOYAGER).order_by(User.handle)).all()
        )
