"""SQLite engine for the identity core.

One module-level engine, lazily built from `settings.auth_db_path`. `main.py`'s
lifespan calls `init_db()` on startup to create tables; later phases (and
`backend/tools/migrate_to_multiuser.py`) can import `get_engine()` /
`get_session()` to reuse the same engine rather than opening a second one.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlmodel import Session, SQLModel, create_engine

from backend.config import settings

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        settings.dbs_dir.mkdir(parents=True, exist_ok=True)
        _engine = create_engine(
            f"sqlite:///{settings.auth_db_path}",
            connect_args={"check_same_thread": False},
        )
    return _engine


def reset_engine() -> None:
    """Drop the cached engine so a new `settings.auth_db_path` takes effect.

    Used by tests that point `settings.dbs_dir` at a tmp_path per test.
    """
    global _engine
    _engine = None


def init_db() -> None:
    # Import models so their tables register on SQLModel.metadata before create_all.
    from backend.auth import models as _models  # noqa: F401

    SQLModel.metadata.create_all(get_engine())


@contextmanager
def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session
