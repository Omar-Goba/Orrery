from __future__ import annotations

import io
from pathlib import Path

from sqlmodel import Session, select

from backend.auth.db import get_engine, init_db
from backend.auth.models import ROLE_VOYAGER, User, utcnow
from backend.auth.security import hash_password
from backend.config import settings
from backend.services.objectstore import LocalObjectStore
from backend.tools.reconcile_storage import reconcile_storage


def _create_user(recorded_bytes: int) -> User:
    init_db()
    user = User(
        id="voyager-id",
        handle="voyageruser",
        display_name="Voyager",
        password_hash=hash_password("longenough123"),
        role=ROLE_VOYAGER,
        storage_used_bytes=recorded_bytes,
        created_at=utcnow(),
    )
    with Session(get_engine()) as db:
        db.add(user)
        db.commit()
        db.refresh(user)
        return user


def test_reconcile_storage_detects_drift_without_fix(tmp_dbs: Path) -> None:
    user = _create_user(recorded_bytes=1)
    objects = LocalObjectStore(settings.objects_dir)
    objects.put(f"users/{user.id}/papers/a.pdf", io.BytesIO(b"abc"))
    objects.put(f"users/{user.id}/papers/b.pdf", io.BytesIO(b"defg"))
    objects.put(f"users/{user.id}/ocr_cache/derived.txt", io.BytesIO(b"not counted"))

    rows = reconcile_storage(fix=False)

    assert len(rows) == 1
    assert rows[0].recorded_bytes == 1
    assert rows[0].actual_bytes == 7
    assert rows[0].drift_bytes == 6
    with Session(get_engine()) as db:
        unchanged = db.exec(select(User).where(User.id == user.id)).one()
        assert unchanged.storage_used_bytes == 1


def test_reconcile_storage_fix_corrects_counter(tmp_dbs: Path) -> None:
    user = _create_user(recorded_bytes=999)
    objects = LocalObjectStore(settings.objects_dir)
    objects.put(f"users/{user.id}/papers/a.pdf", io.BytesIO(b"abc"))

    rows = reconcile_storage(fix=True)

    assert rows[0].actual_bytes == 3
    with Session(get_engine()) as db:
        fixed = db.exec(select(User).where(User.id == user.id)).one()
        assert fixed.storage_used_bytes == 3
