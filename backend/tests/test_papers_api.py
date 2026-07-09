"""Integration tests for the ObjectStore-backed paper endpoints (plan §10).

Covers the phase-2 gate: "upload/read/status/reindex regression." Heavy
model calls (embeddings, summarization, cluster naming) are monkeypatched
to deterministic fakes so these tests run fast and offline — OCR itself is
untouched, exercised against a real (if minimal) PDF fixture.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from backend.clustering.namer import ClusterNamer
from backend.services.embeddings import EmbeddingService
from backend.services.summarize import SummaryResult, SummaryService

MINIMAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    b"xref\n0 4\n0000000000 65535 f \n"
    b"trailer<</Size 4/Root 1 0 R>>\n"
    b"startxref\n0\n%%EOF"
)


def _pdf_bytes(marker: bytes) -> bytes:
    # Distinct bytes (and hence a distinct content-hash paper id) per
    # fixture while remaining a structurally valid PDF.
    return MINIMAL_PDF + b"\n% " + marker + b"\n"


async def _fake_embed_text(self, text: str) -> list[float]:
    return [0.1, 0.2, 0.3]


async def _fake_embed_batch(self, texts: list[str]) -> list[list[float]]:
    return [[0.1, 0.2, 0.3] for _ in texts]


async def _fake_summarize(self, text: str, filename: str) -> SummaryResult:
    return SummaryResult(
        title=f"Title for {filename}",
        author_last="Author",
        year="2024",
        summary="A deterministic test summary with enough words to pass validation checks.",
        source="test",
    )


async def _fake_name_cluster(self, paper_summaries: list[str]) -> str:
    return "Test Cluster"


async def _fake_name_tree(self, tree, records) -> None:
    def _name(nodes: list) -> None:
        for node in nodes:
            if node.is_leaf:
                node.name = "Test Cluster"
            else:
                _name(node.children)
                node.name = "Test Cluster"

    _name(tree)


@pytest.fixture()
def app_client(tmp_dbs: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(EmbeddingService, "embed_text", _fake_embed_text)
    monkeypatch.setattr(EmbeddingService, "embed_batch", _fake_embed_batch)
    monkeypatch.setattr(SummaryService, "summarize", _fake_summarize)
    monkeypatch.setattr(ClusterNamer, "name_cluster", _fake_name_cluster)
    monkeypatch.setattr(ClusterNamer, "name_tree", _fake_name_tree)

    from backend.main import app

    with TestClient(app) as c:
        yield c


def _upload(client: TestClient, data: bytes, filename: str, status: str = "toread"):
    return client.post(
        "/api/papers/upload",
        files={"file": (filename, io.BytesIO(data), "application/pdf")},
        data={"status": status},
    )


def _drain_progress(client: TestClient, job_id: str) -> list[dict]:
    events: list[dict] = []
    with client.stream("GET", f"/api/papers/upload/{job_id}/progress") as resp:
        buf = ""
        for chunk in resp.iter_text():
            buf += chunk
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                if block.startswith("data: "):
                    events.append(json.loads(block[len("data: "):]))
                if events and events[-1]["type"] in ("done", "error"):
                    return events
    return events


def _ingest(client: TestClient, data: bytes, filename: str, status: str = "toread") -> dict:
    resp = _upload(client, data, filename, status)
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    events = _drain_progress(client, job_id)
    assert events, "expected at least one SSE event"
    assert events[-1]["type"] == "done", events
    return events[-1]["paper"]


# ── SSE progress-event shape (frontend contract) ────────────────────────────

def test_upload_progress_event_shapes_are_unchanged(app_client: TestClient) -> None:
    resp = _upload(app_client, _pdf_bytes(b"shape-test"), "shape.pdf")
    assert resp.status_code == 200
    job_id = resp.json()["job_id"]

    events = _drain_progress(app_client, job_id)
    assert events[-1]["type"] == "done"

    for event in events:
        assert event["type"] in ("progress", "done", "error")
        if event["type"] == "progress":
            assert isinstance(event["step"], str)
            assert isinstance(event["pct"], int)
        if event["type"] == "done":
            assert "paper" in event
            paper = event["paper"]
            assert set(["id", "filename", "source_filename", "status"]).issubset(paper)


# ── upload -> file-serving round trip ───────────────────────────────────────

def test_upload_then_download_round_trip(app_client: TestClient) -> None:
    data = _pdf_bytes(b"round-trip")
    paper = _ingest(app_client, data, "roundtrip.pdf")

    listed = app_client.get("/api/papers").json()
    assert any(p["id"] == paper["id"] for p in listed)

    file_resp = app_client.get(f"/api/papers/{paper['id']}/file")
    assert file_resp.status_code == 200
    assert file_resp.headers["content-type"] == "application/pdf"
    assert file_resp.content == data
    assert "roundtrip.pdf" in file_resp.headers["content-disposition"]


def test_download_unknown_paper_is_404(app_client: TestClient) -> None:
    resp = app_client.get("/api/papers/doesnotexist/file")
    assert resp.status_code == 404


# ── content-hash dedup ───────────────────────────────────────────────────────

def test_reupload_identical_bytes_is_409_with_existing_record(
    app_client: TestClient,
) -> None:
    data = _pdf_bytes(b"dedup-test")
    paper = _ingest(app_client, data, "first.pdf")

    dup_resp = _upload(app_client, data, "second-name.pdf")
    assert dup_resp.status_code == 409
    body = dup_resp.json()
    assert body["error"] == "duplicate"
    assert body["paper"]["id"] == paper["id"]

    # No second record was created.
    listed = app_client.get("/api/papers").json()
    assert sum(1 for p in listed if p["id"] == paper["id"]) == 1


def test_different_bytes_get_different_ids(app_client: TestClient) -> None:
    paper_a = _ingest(app_client, _pdf_bytes(b"variant-a"), "a.pdf")
    paper_b = _ingest(app_client, _pdf_bytes(b"variant-b"), "b.pdf")
    assert paper_a["id"] != paper_b["id"]


# ── status PATCH does not touch disk ────────────────────────────────────────

def test_status_update_does_not_create_output_dir(
    app_client: TestClient, tmp_dbs: Path
) -> None:
    paper = _ingest(app_client, _pdf_bytes(b"status-test"), "status.pdf", status="toread")

    resp = app_client.patch(
        f"/api/papers/{paper['id']}/status", json={"status": "read"}
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "read"

    # The symlink-forest concept is gone: there must be no output/ dir, and
    # the object bytes must be untouched by a status change.
    assert not (tmp_dbs / "output").exists()
    file_resp = app_client.get(f"/api/papers/{paper['id']}/file")
    assert file_resp.status_code == 200


def test_status_update_unknown_paper_404(app_client: TestClient) -> None:
    resp = app_client.patch("/api/papers/nope/status", json={"status": "read"})
    assert resp.status_code == 404


def test_status_update_bad_status_400(app_client: TestClient) -> None:
    paper = _ingest(app_client, _pdf_bytes(b"bad-status"), "bad.pdf")
    resp = app_client.patch(
        f"/api/papers/{paper['id']}/status", json={"status": "banana"}
    )
    assert resp.status_code == 400


# ── tree ─────────────────────────────────────────────────────────────────────

def test_tree_reflects_ingested_papers_with_no_disk_io(
    app_client: TestClient, tmp_dbs: Path
) -> None:
    _ingest(app_client, _pdf_bytes(b"tree-test"), "tree.pdf")

    tree = app_client.get("/api/tree").json()
    assert tree["name"] == "library"

    def _find_leaf(node) -> bool:
        if node["type"] == "paper":
            return True
        return any(_find_leaf(c) for c in node["children"])

    assert _find_leaf(tree)
    assert not (tmp_dbs / "output").exists()


# ── reindex ──────────────────────────────────────────────────────────────────

def test_reindex_end_to_end(app_client: TestClient) -> None:
    _ingest(app_client, _pdf_bytes(b"reindex-1"), "r1.pdf")
    _ingest(app_client, _pdf_bytes(b"reindex-2"), "r2.pdf")

    with app_client.stream("POST", "/api/reindex") as resp:
        assert resp.status_code == 200
        buf = ""
        events: list[dict] = []
        for chunk in resp.iter_text():
            buf += chunk
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                if block.startswith("data: "):
                    events.append(json.loads(block[len("data: "):]))
            if events and events[-1]["type"] in ("done", "error"):
                break

    assert events
    assert events[-1]["type"] == "done"

    tree = app_client.get("/api/tree").json()
    assert tree["name"] == "library"


# ── failure hygiene: ingest failure does not leak the object ────────────────

def test_ingest_failure_deletes_the_object(
    app_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from backend import main as main_module

    async def _boom(self, text: str, filename: str) -> SummaryResult:
        raise RuntimeError("simulated ingest failure")

    monkeypatch.setattr(SummaryService, "summarize", _boom)

    data = _pdf_bytes(b"failure-test")
    resp = _upload(app_client, data, "failure.pdf")
    assert resp.status_code == 200
    job_id = resp.json()["job_id"]

    events = _drain_progress(app_client, job_id)
    assert events[-1]["type"] == "error"

    # The object must not have been left behind.
    import hashlib

    paper_id = hashlib.sha256(data).hexdigest()[:16]
    key = f"papers/{paper_id}.pdf"
    assert main_module._object_store.stat(key) is None
