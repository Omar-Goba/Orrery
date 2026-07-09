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


KEEPER_PDF = b"%PDF-1.4\n% keeper tour bytes\n%%EOF"
VOYAGER_PDF = b"%PDF-1.4\n% voyager private bytes\n%%EOF"


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


def _seed_paper(client: TestClient, user: User, paper_id: str, data: bytes) -> PaperRecord:
    record = PaperRecord(
        id=paper_id,
        filename=f"{paper_id}.pdf",
        source_filename=f"{paper_id}.pdf",
        status="read" if user.role == ROLE_KEEPER else "toread",
        title=f"{user.handle} paper",
        author=user.display_name,
        year="2024",
        summary=f"Summary for {user.handle}",
        cluster_path="Public/Constellation" if user.role == ROLE_KEEPER else "Private/Constellation",
        ingested_at=utcnow(),
        ocr_cached=False,
    )
    space = client.app.state.space_registry.get(user.id)
    space.papers.put(record)
    asyncio.run(space.papers.save())
    space.objects.put(f"papers/{paper_id}.pdf", io.BytesIO(data))
    space.vstore.upsert_paper_vector(
        paper_id,
        [1.0, 0.0, 0.0] if user.role == ROLE_KEEPER else [0.0, 1.0, 0.0],
        {"status": record.status, "title": record.title, "cluster_path": record.cluster_path},
    )
    return record


def _seed_keeper_and_voyager(client: TestClient) -> tuple[PaperRecord, PaperRecord]:
    keeper = _create_user("keeperuser", ROLE_KEEPER)
    voyager = _create_user("voyageruser", ROLE_VOYAGER)
    keeper_paper = _seed_paper(client, keeper, "keeper-paper", KEEPER_PDF)
    voyager_paper = _seed_paper(client, voyager, "voyager-paper", VOYAGER_PDF)
    return keeper_paper, voyager_paper


def _sse_events(response: TestClient) -> list[dict]:
    events: list[dict] = []
    for block in response.text.split("\n\n"):
        if block.startswith("data: "):
            events.append(json.loads(block[len("data: "):]))
    return events


def test_anonymous_can_read_keeper_tour_routes_and_file(client: TestClient) -> None:
    keeper_paper, _voyager_paper = _seed_keeper_and_voyager(client)

    galaxy = client.get("/api/tour/galaxy")
    assert galaxy.status_code == 200, galaxy.text
    assert galaxy.json() == {
        "display_name": "Keeperuser",
        "stars": 1,
        "ignited": 1,
        "constellations": 1,
    }

    papers = client.get("/api/tour/papers")
    assert papers.status_code == 200, papers.text
    assert [paper["id"] for paper in papers.json()] == [keeper_paper.id]

    tree = client.get("/api/tour/tree")
    assert tree.status_code == 200, tree.text
    assert keeper_paper.id in json.dumps(tree.json())

    similarity = client.get("/api/tour/similarity")
    assert similarity.status_code == 200, similarity.text
    assert similarity.json() == {keeper_paper.id: []}

    file_resp = client.get(f"/api/tour/papers/{keeper_paper.id}/file")
    assert file_resp.status_code == 200, file_resp.text
    assert file_resp.headers["content-type"] == "application/pdf"
    assert file_resp.content == KEEPER_PDF


def test_anonymous_normal_papers_remains_401(client: TestClient) -> None:
    _seed_keeper_and_voyager(client)

    resp = client.get("/api/papers")

    assert resp.status_code == 401



def test_tour_routes_only_expose_keeper_not_voyager_data(client: TestClient) -> None:
    keeper_paper, voyager_paper = _seed_keeper_and_voyager(client)

    body = json.dumps(client.get("/api/tour/papers").json())

    assert keeper_paper.id in body
    assert "keeperuser paper" in body
    assert voyager_paper.id not in body
    assert "voyageruser paper" not in body

    voyager_file = client.get(f"/api/tour/papers/{voyager_paper.id}/file")
    assert voyager_file.status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/tour/papers/upload"),
        ("patch", "/api/tour/papers/keeper-paper/status"),
        ("delete", "/api/tour/papers/keeper-paper"),
        ("post", "/api/tour/reindex"),
        ("get", "/api/tour/recommendations"),
    ],
)
def test_tour_has_no_mutating_or_recommendation_routes(
    client: TestClient, method: str, path: str
) -> None:
    _seed_keeper_and_voyager(client)

    resp = getattr(client, method)(path)

    assert resp.status_code in (404, 405)


def test_tour_chat_enabled_streams_sse_from_keeper_oracle(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_keeper_and_voyager(client)

    async def fake_stream(self, question: str):
        yield f"data: {json.dumps({'type': 'chunk', 'text': f'answer:{question}'})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    from backend.agents.oracle import OracleAgent

    monkeypatch.setattr(OracleAgent, "stream", fake_stream)

    resp = client.post("/api/tour/chat", json={"message": "hello", "history": []})

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert _sse_events(resp) == [
        {"type": "chunk", "text": "answer:hello"},
        {"type": "done"},
    ]


def test_tour_chat_disabled_returns_error(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.config import settings

    monkeypatch.setattr(settings, "tour_chat_enabled", False)
    _seed_keeper_and_voyager(client)

    resp = client.post("/api/tour/chat", json={"message": "hello", "history": []})

    assert resp.status_code == 503
    assert resp.json()["detail"] == "Tour chat is disabled"


def test_tour_chat_is_rate_limited_per_ip(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_keeper_and_voyager(client)

    async def fake_stream(self, question: str):
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    from backend.agents.oracle import OracleAgent

    monkeypatch.setattr(OracleAgent, "stream", fake_stream)

    statuses = [
        client.post("/api/tour/chat", json={"message": "hello", "history": []}).status_code
        for _ in range(11)
    ]

    assert statuses[:10] == [200] * 10
    assert statuses[10] == 429


def test_no_keeper_present_returns_consistent_failure(client: TestClient) -> None:
    _create_user("voyageronly", ROLE_VOYAGER)

    for method, path in [
        ("get", "/api/tour/galaxy"),
        ("get", "/api/tour/papers"),
        ("get", "/api/tour/tree"),
        ("get", "/api/tour/similarity"),
        ("get", "/api/tour/papers/missing/file"),
        ("post", "/api/tour/chat"),
    ]:
        resp = getattr(client, method)(path, json={"message": "hi", "history": []}) if method == "post" else getattr(client, method)(path)
        assert resp.status_code == 503
        assert resp.json()["detail"] == "Keeper galaxy unavailable"


def test_multiple_keepers_returns_consistent_failure(client: TestClient) -> None:
    _create_user("keeperone", ROLE_KEEPER)
    _create_user("keepertwo", ROLE_KEEPER)

    resp = client.get("/api/tour/papers")

    assert resp.status_code == 503
    assert resp.json()["detail"] == "Keeper galaxy unavailable"


def test_tour_never_uses_client_supplied_user_selector(client: TestClient) -> None:
    keeper_paper, voyager_paper = _seed_keeper_and_voyager(client)

    resp = client.get("/api/tour/papers", params={"handle": "voyageruser", "user_id": "voyager-id"})

    ids = [paper["id"] for paper in resp.json()]
    assert ids == [keeper_paper.id]
    assert voyager_paper.id not in ids


def test_keeper_lookup_ignores_disabled_keeper(client: TestClient) -> None:
    disabled_keeper = _create_user("disabledkeeper", ROLE_KEEPER)
    with Session(get_engine()) as db:
        user = db.exec(select(User).where(User.id == disabled_keeper.id)).one()
        user.disabled = True
        db.add(user)
        db.commit()

    resp = client.get("/api/tour/papers")

    assert resp.status_code == 503
    assert resp.json()["detail"] == "Keeper galaxy unavailable"
