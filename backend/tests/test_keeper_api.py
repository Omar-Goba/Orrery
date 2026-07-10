from __future__ import annotations

import asyncio
import io
import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend.auth.db import get_engine
from backend.auth.models import ROLE_KEEPER, ROLE_VOYAGER, User, utcnow
from backend.auth.security import hash_password
from backend.models import PaperRecord


VOYAGER_BYTES = b"%PDF-1.4\n% voyager bytes\n%%EOF"


def _create_user(handle: str, role: str) -> User:
    user = User(
        id=f"{handle}-id",
        handle=handle,
        display_name=handle.title(),
        password_hash=hash_password("longenough123"),
        role=role,
        created_at=utcnow(),
    )
    with Session(get_engine()) as db:
        db.add(user)
        db.commit()
        db.refresh(user)
        return user


def _login(client: TestClient, handle: str) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"handle": handle, "password": "longenough123"},
    )
    assert resp.status_code == 200, resp.text


def _seed_voyager_file(client: TestClient, voyager: User) -> PaperRecord:
    record = PaperRecord(
        id="voyager-paper",
        filename="private-title.pdf",
        source_filename="upload-name.pdf",
        status="read",
        title="forbidden title",
        author="forbidden author",
        year="2099",
        summary="forbidden summary",
        cluster_path="Forbidden/Cluster",
        ingested_at=utcnow(),
        ocr_cached=False,
    )
    space = client.app.state.space_registry.get(voyager.id)
    space.papers.put(record)
    asyncio.run(space.papers.save())
    space.objects.put(f"papers/{record.id}.pdf", io.BytesIO(VOYAGER_BYTES))
    with Session(get_engine()) as db:
        user = db.exec(select(User).where(User.id == voyager.id)).one()
        user.storage_used_bytes = len(VOYAGER_BYTES)
        db.add(user)
        db.commit()
    return record


def _seed_keeper_lens(client: TestClient) -> tuple[User, User, PaperRecord]:
    keeper = _create_user("keeperuser", ROLE_KEEPER)
    voyager = _create_user("voyageruser", ROLE_VOYAGER)
    paper = _seed_voyager_file(client, voyager)
    return keeper, voyager, paper


def test_keeper_lens_lists_summaries_and_files_metadata_only(client: TestClient) -> None:
    _keeper, _voyager, paper = _seed_keeper_lens(client)
    _login(client, "keeperuser")

    summaries = client.get("/api/keeper/voyagers")
    assert summaries.status_code == 200, summaries.text
    assert summaries.json() == [
        {
            "handle": "voyageruser",
            "display_name": "Voyageruser",
            "created_at": summaries.json()[0]["created_at"],
            "paper_count": 1,
            "storage_used_bytes": len(VOYAGER_BYTES),
            "storage_quota_bytes": 500 * 1024 * 1024,
            "disabled": False,
        }
    ]

    files = client.get("/api/keeper/voyagers/voyageruser/files")
    assert files.status_code == 200, files.text
    assert files.json() == [
        {
            "paper_id": paper.id,
            "filename": "upload-name.pdf",
            "size_bytes": len(VOYAGER_BYTES),
            "uploaded_at": files.json()[0]["uploaded_at"],
        }
    ]

    serialized = json.dumps({"summaries": summaries.json(), "files": files.json()})
    for forbidden in ["status", "summary", "cluster_path", "title", "author", "year"]:
        assert forbidden not in serialized


def test_keeper_quota_patch_requires_keeper(client: TestClient) -> None:
    _keeper, _voyager, _paper = _seed_keeper_lens(client)

    anon = client.patch(
        "/api/keeper/voyagers/voyageruser/quota",
        json={"storage_quota_bytes": 1234},
    )
    assert anon.status_code == 401

    _login(client, "voyageruser")
    voyager_resp = client.patch(
        "/api/keeper/voyagers/voyageruser/quota",
        json={"storage_quota_bytes": 1234},
    )
    assert voyager_resp.status_code == 403

    client.post("/api/auth/logout")
    _login(client, "keeperuser")
    keeper_resp = client.patch(
        "/api/keeper/voyagers/voyageruser/quota",
        json={"storage_quota_bytes": 1234},
    )
    assert keeper_resp.status_code == 200, keeper_resp.text
    assert keeper_resp.json()["storage_quota_bytes"] == 1234


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/keeper/voyagers"),
        ("get", "/api/keeper/voyagers/voyageruser/files"),
        ("get", "/api/keeper/voyagers/voyageruser/files/voyager-paper/raw"),
    ],
)
def test_keeper_lens_read_routes_require_keeper(
    client: TestClient,
    method: str,
    path: str,
) -> None:
    _seed_keeper_lens(client)

    anon = getattr(client, method)(path)
    assert anon.status_code == 401

    _login(client, "voyageruser")
    voyager_resp = getattr(client, method)(path)
    assert voyager_resp.status_code == 403


def test_keeper_raw_file_default_403_and_flag_streams(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _keeper, _voyager, paper = _seed_keeper_lens(client)
    _login(client, "keeperuser")

    default_resp = client.get(f"/api/keeper/voyagers/voyageruser/files/{paper.id}/raw")
    assert default_resp.status_code == 403

    from backend.config import settings

    monkeypatch.setattr(settings, "keeper_can_open_files", True)
    enabled_resp = client.get(f"/api/keeper/voyagers/voyageruser/files/{paper.id}/raw")
    assert enabled_resp.status_code == 200, enabled_resp.text
    assert enabled_resp.headers["content-type"] == "application/pdf"
    assert enabled_resp.content == VOYAGER_BYTES
