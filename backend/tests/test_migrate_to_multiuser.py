"""`backend.tools.migrate_to_multiuser` tests (plan §11).

CRITICAL: every fixture here is synthetic and lives entirely under the
`tmp_dbs` fixture (pytest `tmp_path` + `settings.dbs_dir` monkeypatched) —
this test suite must NEVER point at, read, or write this machine's actual
`dbs/` directory. We simulate "real data" shape (a `papers.json` with a
couple of legacy-id records, a couple of fake PDFs under `input/`, and a
legacy Chroma sqlite with the two pre-multiuser global collections
populated) rather than ever touching anything real.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import Session, select

from backend.auth.db import get_engine, init_db
from backend.auth.models import ROLE_KEEPER, User
from backend.models import ChunkRecord
from backend.services.vectorstore import (
    CHUNKS_COLLECTION,
    PAPERS_COLLECTION,
    VectorStore,
)
from backend.store import paper_id_for_bytes
from backend.tools.migrate_to_multiuser import run_migration

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
    return MINIMAL_PDF + b"\n% " + marker + b"\n"


def _fail_if_called() -> str:
    raise AssertionError("password_provider must not be called again once the Keeper exists")


@pytest.fixture()
def legacy_dbs(tmp_dbs: Path) -> Path:
    """Populate `tmp_dbs` with synthetic pre-migration data:
    - `papers.json` with two legacy-id records (ids that do NOT match a
      content hash of their bytes — exactly the pre-migration shape).
    - `input/paper-a.pdf`, `input/paper-b.pdf` — the backing bytes.
    - Legacy Chroma collections (`paper_chunks`, `paper_vectors`) populated
      through the real `VectorStore` facade (legacy names, `user_id=None`).
    """
    from backend.config import settings

    input_dir = tmp_dbs / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    (input_dir / "paper-a.pdf").write_bytes(_pdf_bytes(b"paper-a"))
    (input_dir / "paper-b.pdf").write_bytes(_pdf_bytes(b"paper-b"))

    legacy_records = {
        "legacyhash0001": {
            "filename": "paper-a.pdf",
            "original_path": "paper-a.pdf",
            "status": "toread",
            "title": "Paper A",
            "author": "Alpha",
            "year": "2021",
            "summary": "Summary A",
            "cluster_path": "Folder/Sub",
            "ingested_at": None,
            "ocr_cached": True,
        },
        "legacyhash0002": {
            "filename": "paper-b.pdf",
            "original_path": "paper-b.pdf",
            "status": "read",
            "title": "Paper B",
            "author": "Beta",
            "year": "2022",
            "summary": "Summary B",
            "cluster_path": "Folder",
            "ingested_at": None,
            "ocr_cached": True,
            "symlink_name": "beta2022_paper_b_read.pdf",  # dead pre-phase-2 field
        },
    }
    (tmp_dbs / "papers.json").write_text(json.dumps(legacy_records, indent=2))

    client = VectorStore.build_client(settings.chroma_persist_dir)
    legacy_vstore = VectorStore(client)  # user_id=None -> legacy collection names

    legacy_vstore.add_chunks(
        "legacyhash0001",
        [ChunkRecord(paper_id="legacyhash0001", chunk_index=0, text="chunk a0", token_count=2),
         ChunkRecord(paper_id="legacyhash0001", chunk_index=1, text="chunk a1", token_count=2)],
        [[0.1, 0.2, 0.3], [0.15, 0.25, 0.35]],
    )
    legacy_vstore.upsert_paper_vector(
        "legacyhash0001", [0.1, 0.2, 0.3], {"paper_id": "legacyhash0001", "title": "Paper A"}
    )
    legacy_vstore.add_chunks(
        "legacyhash0002",
        [ChunkRecord(paper_id="legacyhash0002", chunk_index=0, text="chunk b0", token_count=2)],
        [[0.4, 0.5, 0.6]],
    )
    legacy_vstore.upsert_paper_vector(
        "legacyhash0002", [0.4, 0.5, 0.6], {"paper_id": "legacyhash0002", "title": "Paper B"}
    )

    return tmp_dbs


def _expected_ids(legacy_dbs: Path) -> tuple[str, str]:
    a = paper_id_for_bytes((legacy_dbs / "input" / "paper-a.pdf").read_bytes())
    b = paper_id_for_bytes((legacy_dbs / "input" / "paper-b.pdf").read_bytes())
    return a, b


# ── first run ────────────────────────────────────────────────────────────────

def test_migration_creates_keeper_and_migrates_everything(legacy_dbs: Path) -> None:
    from backend.config import settings

    report = run_migration(password_provider=lambda: "keeper-password-1")

    assert report.created_new_keeper is True
    assert report.keeper_id

    with Session(get_engine()) as db:
        keeper = db.get(User, report.keeper_id)
        assert keeper is not None
        assert keeper.handle == "omar"
        assert keeper.role == ROLE_KEEPER
        assert keeper.storage_quota_bytes == settings.keeper_quota_bytes
        assert keeper.storage_used_bytes == report.bytes_after
        assert keeper.storage_used_bytes > 0

    new_id_a, new_id_b = _expected_ids(legacy_dbs)

    user_papers_path = settings.user_papers_json(report.keeper_id)
    assert user_papers_path.exists()
    new_records = json.loads(user_papers_path.read_text())
    assert set(new_records.keys()) == {new_id_a, new_id_b}
    assert new_records[new_id_a]["title"] == "Paper A"
    assert new_records[new_id_a]["source_filename"] == "paper-a.pdf"
    assert "symlink_name" not in new_records[new_id_b]

    # object bytes landed under the Keeper's scoped prefix
    obj_a = settings.objects_dir / "users" / report.keeper_id / "papers" / f"{new_id_a}.pdf"
    obj_b = settings.objects_dir / "users" / report.keeper_id / "papers" / f"{new_id_b}.pdf"
    assert obj_a.is_file()
    assert obj_b.is_file()
    assert obj_a.read_bytes() == (legacy_dbs / "input" / "paper-a.pdf").read_bytes()

    # Chroma: new per-user collections hold the remapped ids
    client = VectorStore.build_client(settings.chroma_persist_dir)
    new_chunks = client.get_collection(f"u{report.keeper_id}_chunks")
    new_papers = client.get_collection(f"u{report.keeper_id}_papers")
    assert new_chunks.count() == 3  # 2 chunks for A + 1 for B
    assert new_papers.count() == 2

    paper_dump = new_papers.get(ids=[new_id_a])
    assert paper_dump["metadatas"][0]["paper_id"] == new_id_a

    chunk_dump = new_chunks.get(where={"paper_id": new_id_a})
    assert len(chunk_dump["ids"]) == 2
    assert set(chunk_dump["ids"]) == {f"{new_id_a}_chunk_0", f"{new_id_a}_chunk_1"}

    assert report.papers_before == 2
    assert report.papers_after == 2
    assert report.chunks_before == 3
    assert report.chunks_after == 3
    assert report.bytes_before == report.bytes_after
    assert report.ok() is True


def test_migration_never_deletes_source_data(legacy_dbs: Path) -> None:
    from backend.config import settings

    original_papers_json = (legacy_dbs / "papers.json").read_text()
    original_a = (legacy_dbs / "input" / "paper-a.pdf").read_bytes()
    original_b = (legacy_dbs / "input" / "paper-b.pdf").read_bytes()

    run_migration(password_provider=lambda: "keeper-password-1")

    assert (legacy_dbs / "papers.json").read_text() == original_papers_json
    assert (legacy_dbs / "input" / "paper-a.pdf").read_bytes() == original_a
    assert (legacy_dbs / "input" / "paper-b.pdf").read_bytes() == original_b

    client = VectorStore.build_client(settings.chroma_persist_dir)
    legacy_chunks = client.get_collection(CHUNKS_COLLECTION)
    legacy_papers = client.get_collection(PAPERS_COLLECTION)
    assert legacy_chunks.count() == 3
    assert legacy_papers.count() == 2
    assert set(legacy_papers.get()["ids"]) == {"legacyhash0001", "legacyhash0002"}


# ── idempotency ──────────────────────────────────────────────────────────────

def test_migration_is_idempotent(legacy_dbs: Path) -> None:
    from backend.config import settings

    first = run_migration(password_provider=lambda: "keeper-password-1")
    second = run_migration(password_provider=_fail_if_called)

    assert second.created_new_keeper is False
    assert second.keeper_id == first.keeper_id
    assert second.papers_after == first.papers_after
    assert second.chunks_after == first.chunks_after
    assert second.bytes_after == first.bytes_after

    # No duplicate user rows.
    with Session(get_engine()) as db:
        keepers = db.exec(select(User).where(User.role == ROLE_KEEPER)).all()
        assert len(keepers) == 1

    # No duplicate papers.json entries.
    new_records = json.loads(settings.user_papers_json(first.keeper_id).read_text())
    assert len(new_records) == 2

    # No duplicate objects / vectors.
    client = VectorStore.build_client(settings.chroma_persist_dir)
    new_chunks = client.get_collection(f"u{first.keeper_id}_chunks")
    new_papers = client.get_collection(f"u{first.keeper_id}_papers")
    assert new_chunks.count() == 3
    assert new_papers.count() == 2

    objects_root = settings.objects_dir / "users" / first.keeper_id / "papers"
    assert len(list(objects_root.glob("*.pdf"))) == 2


def test_report_print_table_runs_without_error(legacy_dbs: Path, capsys) -> None:
    report = run_migration(password_provider=lambda: "keeper-password-1")
    report.print_table()
    out = capsys.readouterr().out
    assert "papers" in out
    assert "OK" in out


# ── empty-state idempotency (no legacy papers.json at all) ──────────────────

def test_migration_with_no_legacy_data_just_creates_the_keeper(tmp_dbs: Path) -> None:
    report = run_migration(password_provider=lambda: "keeper-password-1")
    assert report.created_new_keeper is True
    assert report.papers_before == 0
    assert report.papers_after == 0
    assert report.chunks_before == 0
    assert report.chunks_after == 0
    assert report.ok() is True

    # Running again still doesn't re-prompt or duplicate the keeper.
    second = run_migration(password_provider=_fail_if_called)
    assert second.created_new_keeper is False
    assert second.keeper_id == report.keeper_id
