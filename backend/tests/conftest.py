"""Shared test fixtures: a tmp-path `dbs/` per test and an app TestClient.

Backend tests run from the repo root (`python -m pytest backend/tests`), so
without this fixture tests would read/write the real `dbs/` directory.
Everything here is additive — it does not touch `backend/tests/test_hierarchical.py`,
`test_namer.py`, or `test_summarize.py`, which have no DB/app dependency.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _dummy_openai_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # Role clients are constructed from the module-level settings singleton.
    # Patch API keys directly rather than env vars, which are too late by now.
    from backend.config import settings

    for role in (
        settings.llm_summary,
        settings.llm_namer,
        settings.llm_embedder,
        settings.llm_oracle,
        settings.llm_curator,
        settings.llm_master,
    ):
        monkeypatch.setattr(role, "api_key", "sk-test-dummy")


@pytest.fixture(autouse=True)
def _reset_rate_limiters() -> None:
    # Rate limiter state is module-level (in-process); tests that hit the
    # limit on purpose must not leak into other tests.
    from backend.auth.ratelimit import client_log_limiter, login_limiter, signup_limiter, tour_chat_limiter

    client_log_limiter.reset()
    login_limiter.reset()
    signup_limiter.reset()
    tour_chat_limiter.reset()
    yield
    client_log_limiter.reset()
    login_limiter.reset()
    signup_limiter.reset()
    tour_chat_limiter.reset()


@pytest.fixture()
def tmp_dbs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point settings.dbs_dir (and the auth engine) at a fresh tmp directory."""
    from backend.auth import db as auth_db
    from backend.config import settings

    dbs_dir = tmp_path / "dbs"
    dbs_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "dbs_dir", dbs_dir)
    monkeypatch.setattr(settings, "chroma_persist_dir", dbs_dir / "chroma")
    auth_db.reset_engine()
    yield dbs_dir
    auth_db.reset_engine()


@pytest.fixture()
def client(tmp_dbs: Path) -> Iterator[TestClient]:
    from backend.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def db_session(tmp_dbs: Path):
    from backend.auth.db import get_engine, init_db
    from sqlmodel import Session

    init_db()
    with Session(get_engine()) as session:
        yield session
