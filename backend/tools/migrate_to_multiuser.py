"""One-time migration: Omar's single-tenant data becomes the Keeper's galaxy.

Run as `python -m backend.tools.migrate_to_multiuser` from the repo root.
Idempotent (plan §11) — every step recomputes its output deterministically
from the untouched legacy sources and either creates-or-reuses (the Keeper
user) or upserts (papers.json, objects, Chroma vectors), so running it twice
never duplicates data and never re-prompts for a password once the Keeper
account exists.

**Never deletes source data.** `dbs/papers.json`, `dbs/input/`, and the
legacy `paper_chunks`/`paper_vectors` Chroma collections are left exactly
where they were; this script only ever reads them and writes to the new
`dbs/users/{keeper_id}/...` / `u{keeper_id}_*` locations.

CRITICAL: this script creates a privileged Keeper user and moves real
people's files into per-user namespaces — real enough consequences that its
own test suite (`backend/tests/test_migrate_to_multiuser.py`) only ever
invokes `run_migration()` against synthetic fixtures built under a pytest
`tmp_path` with `settings.dbs_dir` monkeypatched away from the real
directory. It must never be run against this machine's actual `dbs/`.
"""
from __future__ import annotations

import asyncio
import getpass
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import chromadb
from sqlmodel import Session, select

from backend.auth.db import get_engine, init_db
from backend.auth.models import ROLE_KEEPER, User
from backend.auth.security import hash_password
from backend.config import settings
from backend.models import PaperRecord
from backend.services.objectstore import LocalObjectStore, ScopedObjectStore
from backend.services.vectorstore import CHUNKS_COLLECTION, PAPERS_COLLECTION, VectorStore
from backend.store import PaperStore, paper_id_for_bytes

KEEPER_HANDLE = "omar"
MIN_KEEPER_PASSWORD_LEN = 10


@dataclass
class MigrationReport:
    keeper_id: str = ""
    created_new_keeper: bool = False
    papers_before: int = 0
    papers_after: int = 0
    chunks_before: int = 0
    chunks_after: int = 0
    bytes_before: int = 0
    bytes_after: int = 0

    def ok(self) -> bool:
        return (
            self.papers_before == self.papers_after
            and self.chunks_before == self.chunks_after
            and self.bytes_before == self.bytes_after
        )

    def print_table(self) -> None:
        rows = [
            ("papers", self.papers_before, self.papers_after),
            ("chunks", self.chunks_before, self.chunks_after),
            ("bytes", self.bytes_before, self.bytes_after),
        ]
        name_w = max(len(r[0]) for r in rows)
        print(f"{'metric':<{name_w}}  {'before':>14}  {'after':>14}  match")
        for name, before, after in rows:
            status = "OK" if before == after else "MISMATCH"
            print(f"{name:<{name_w}}  {before:>14}  {after:>14}  {status}")


def _prompt_keeper_password() -> str:
    """Interactive prompt, never hardcoded / env / argv (plan §11 step 1)."""
    while True:
        pw = getpass.getpass("Set a password for the Keeper account (omar): ")
        if len(pw) < MIN_KEEPER_PASSWORD_LEN:
            print(f"Password must be at least {MIN_KEEPER_PASSWORD_LEN} characters.")
            continue
        confirm = getpass.getpass("Confirm password: ")
        if pw != confirm:
            print("Passwords do not match.")
            continue
        return pw


def _get_or_create_keeper(
    db: Session, password_provider: Callable[[], str]
) -> tuple[User, bool]:
    existing = db.exec(select(User).where(User.role == ROLE_KEEPER)).first()
    if existing is not None:
        return existing, False

    password = password_provider()
    user = User(
        id=uuid.uuid4().hex,
        handle=KEEPER_HANDLE,
        display_name="Omar",
        password_hash=hash_password(password),
        role=ROLE_KEEPER,
        storage_quota_bytes=settings.keeper_quota_bytes,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user, True


def _load_legacy_papers() -> dict[str, dict]:
    p = settings.papers_json
    if not p.exists():
        return {}
    return json.loads(p.read_text())


def _resolve_legacy_pdf_path(record: dict) -> Path | None:
    """Legacy records' PDF bytes live at `dbs/input/{basename}`.

    Defensive against whichever field survived on a given record —
    `source_filename` (current), `original_path` (pre-phase-2, full or
    relative path), or bare `filename` — only the basename is ever used to
    address `dbs/input/`, never the raw stored path.
    """
    name = record.get("source_filename") or record.get("original_path") or record.get("filename")
    if not name:
        return None
    candidate = settings.dbs_dir / "input" / Path(name).name
    return candidate if candidate.is_file() else None


def _remap_chunk_id(old_chunk_id: str, id_map: dict[str, str]) -> str:
    """Chunk ids look like `{paper_id}_chunk_{index}` (vectorstore.py
    `add_chunks`). `paper_id` is a hex content hash, so it never contains
    the `_chunk_` separator itself — this split is unambiguous."""
    if "_chunk_" not in old_chunk_id:
        return old_chunk_id
    old_pid, _, idx = old_chunk_id.partition("_chunk_")
    new_pid = id_map.get(old_pid, old_pid)
    return f"{new_pid}_chunk_{idx}"


def _migrate_chroma(
    client: chromadb.PersistentClient, keeper_id: str, id_map: dict[str, str]
) -> tuple[int, int]:
    """Copy `paper_chunks`/`paper_vectors` into the Keeper's per-user
    collections verbatim — no re-OCR, no re-embedding, vectors move as-is
    (plan §11 step 4). Returns `(chunks_before, chunks_after)`.
    """
    existing_names = {c.name for c in client.list_collections()}
    new_vstore = VectorStore(client, user_id=keeper_id)

    chunks_before = 0
    if CHUNKS_COLLECTION in existing_names:
        legacy_chunks = client.get_collection(CHUNKS_COLLECTION)
        dump = legacy_chunks.get(include=["embeddings", "documents", "metadatas"])
        chunks_before = len(dump["ids"])
        if chunks_before:
            new_ids = [_remap_chunk_id(i, id_map) for i in dump["ids"]]
            new_metas = []
            for meta in dump["metadatas"]:
                meta = dict(meta)
                if "paper_id" in meta:
                    meta["paper_id"] = id_map.get(meta["paper_id"], meta["paper_id"])
                new_metas.append(meta)
            new_vstore.raw_chunks_collection().upsert(
                ids=new_ids,
                embeddings=dump["embeddings"],
                documents=dump["documents"],
                metadatas=new_metas,
            )

    if PAPERS_COLLECTION in existing_names:
        legacy_papers = client.get_collection(PAPERS_COLLECTION)
        dump = legacy_papers.get(include=["embeddings", "metadatas"])
        if dump["ids"]:
            new_ids = [id_map.get(i, i) for i in dump["ids"]]
            new_metas = []
            for meta in dump["metadatas"]:
                meta = dict(meta)
                if "paper_id" in meta:
                    meta["paper_id"] = id_map.get(meta["paper_id"], meta["paper_id"])
                new_metas.append(meta)
            new_vstore.raw_papers_collection().upsert(
                ids=new_ids,
                embeddings=dump["embeddings"],
                metadatas=new_metas,
            )

    chunks_after = new_vstore.raw_chunks_collection().count()
    return chunks_before, chunks_after


def run_migration(
    *, password_provider: Callable[[], str] = _prompt_keeper_password
) -> MigrationReport:
    report = MigrationReport()

    settings.dbs_dir.mkdir(parents=True, exist_ok=True)
    init_db()  # dbs/orrery.db — idempotent (create_all)

    with Session(get_engine()) as db:
        keeper, created = _get_or_create_keeper(db, password_provider)
        report.keeper_id = keeper.id
        report.created_new_keeper = created

        legacy_records = _load_legacy_papers()
        report.papers_before = len(legacy_records)

        object_store = LocalObjectStore(settings.objects_dir)
        scoped = ScopedObjectStore(object_store, settings.user_object_prefix(keeper.id))

        id_map: dict[str, str] = {}
        new_records: dict[str, PaperRecord] = {}
        bytes_before = 0

        for old_id, raw in legacy_records.items():
            pdf_path = _resolve_legacy_pdf_path(raw)
            if pdf_path is None:
                # No backing bytes found under dbs/input/ — keep the legacy
                # id rather than inventing a content hash with nothing to
                # hash. Metadata still migrates; there's just no PDF to copy.
                new_id = old_id
            else:
                data = pdf_path.read_bytes()
                bytes_before += len(data)
                new_id = paper_id_for_bytes(data)
                with open(pdf_path, "rb") as f:
                    scoped.put(f"papers/{new_id}.pdf", f)
            id_map[old_id] = new_id

            source_name = Path(
                raw.get("source_filename")
                or raw.get("original_path")
                or raw.get("filename")
                or f"{new_id}.pdf"
            ).name

            new_records[new_id] = PaperRecord(
                id=new_id,
                filename=raw.get("filename") or source_name,
                source_filename=source_name,
                status=raw.get("status", "toread"),
                title=raw.get("title"),
                author=raw.get("author"),
                year=raw.get("year"),
                summary=raw.get("summary"),
                cluster_path=raw.get("cluster_path"),
                ingested_at=raw.get("ingested_at"),
                ocr_cached=raw.get("ocr_cached", False),
                # `symlink_name` (pre-phase-2 field) is deliberately not
                # read from `raw` — dropped per plan §11 step 2, defensively,
                # even though phase 2 should already have removed it.
            )

        report.bytes_before = bytes_before

        user_store = PaperStore(settings.user_papers_json(keeper.id))
        for record in new_records.values():
            user_store.put(record)
        asyncio.run(user_store.save())
        report.papers_after = len(user_store.as_dict())
        report.bytes_after = sum(o.size_bytes for o in scoped.list("papers/"))

        client = VectorStore.build_client(settings.chroma_persist_dir)
        report.chunks_before, report.chunks_after = _migrate_chroma(
            client, keeper.id, id_map
        )

        keeper.storage_used_bytes = report.bytes_after
        keeper.storage_quota_bytes = settings.keeper_quota_bytes
        db.add(keeper)
        db.commit()

    return report


def main() -> None:
    report = run_migration()
    print(
        f"Keeper user: id={report.keeper_id} "
        f"({'created' if report.created_new_keeper else 'already existed'})"
    )
    report.print_table()
    if not report.ok():
        raise SystemExit(
            "Migration verification FAILED — counts do not match. "
            "Old sources were left untouched; investigate before trusting "
            "the new per-user data."
        )
    print("Migration verified OK. Old dbs/papers.json, dbs/input/, and the "
          "legacy Chroma collections were left in place, untouched.")


if __name__ == "__main__":
    main()
