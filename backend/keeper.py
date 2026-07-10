from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from backend.auth.deps import get_db, require_keeper
from backend.auth.models import ROLE_VOYAGER, User
from backend.config import settings
from backend.models import QuotaPatchRequest, StoredFileEntry, VoyagerStorageSummary
from backend.services.reembed_job import reembed_status
from backend.services.streaming import stream_object
from backend.space import SpaceRegistry, get_space_registry

router = APIRouter(prefix="/api/keeper", tags=["keeper"])


@router.get("/reembed/status")
async def get_reembed_status(
    _keeper: User = Depends(require_keeper),
) -> dict:
    return reembed_status()


def _voyager_or_404(handle: str, db: Session) -> User:
    user = db.exec(
        select(User).where(User.handle == handle, User.role == ROLE_VOYAGER)
    ).first()
    if user is None:
        raise HTTPException(404, "Voyager not found")
    return user


def _summary_for(user: User, registry: SpaceRegistry) -> VoyagerStorageSummary:
    space = registry.get(user.id)
    return VoyagerStorageSummary(
        handle=user.handle,
        display_name=user.display_name,
        created_at=user.created_at,
        paper_count=len(space.papers.all()),
        storage_used_bytes=user.storage_used_bytes,
        storage_quota_bytes=user.storage_quota_bytes,
        disabled=user.disabled,
    )


@router.get("/voyagers", response_model=list[VoyagerStorageSummary])
async def list_voyagers(
    _keeper: User = Depends(require_keeper),
    db: Session = Depends(get_db),
    registry: SpaceRegistry = Depends(get_space_registry),
) -> list[VoyagerStorageSummary]:
    voyagers = db.exec(
        select(User).where(User.role == ROLE_VOYAGER).order_by(User.handle)
    ).all()
    return [_summary_for(user, registry) for user in voyagers]


@router.get("/voyagers/{handle}/files", response_model=list[StoredFileEntry])
async def list_voyager_files(
    handle: str,
    _keeper: User = Depends(require_keeper),
    db: Session = Depends(get_db),
    registry: SpaceRegistry = Depends(get_space_registry),
) -> list[StoredFileEntry]:
    voyager = _voyager_or_404(handle, db)
    space = registry.get(voyager.id)
    entries: list[StoredFileEntry] = []
    for record in space.papers.all():
        stat = space.objects.stat(f"papers/{record.id}.pdf")
        if stat is None:
            continue
        entries.append(
            StoredFileEntry(
                paper_id=record.id,
                filename=record.source_filename or record.filename,
                size_bytes=stat.size_bytes,
                uploaded_at=record.ingested_at or stat.modified_at or datetime.now(timezone.utc),
            )
        )
    entries.sort(key=lambda entry: entry.uploaded_at, reverse=True)
    return entries


@router.patch("/voyagers/{handle}/quota", response_model=VoyagerStorageSummary)
async def update_voyager_quota(
    handle: str,
    body: QuotaPatchRequest,
    _keeper: User = Depends(require_keeper),
    db: Session = Depends(get_db),
    registry: SpaceRegistry = Depends(get_space_registry),
) -> VoyagerStorageSummary:
    voyager = _voyager_or_404(handle, db)
    voyager.storage_quota_bytes = body.storage_quota_bytes
    db.add(voyager)
    db.commit()
    db.refresh(voyager)
    return _summary_for(voyager, registry)


@router.get("/voyagers/{handle}/files/{paper_id}/raw")
async def get_voyager_raw_file(
    handle: str,
    paper_id: str,
    _keeper: User = Depends(require_keeper),
    db: Session = Depends(get_db),
    registry: SpaceRegistry = Depends(get_space_registry),
):
    if not settings.keeper_can_open_files:
        raise HTTPException(403, "Keeper file opening is disabled")

    voyager = _voyager_or_404(handle, db)
    space = registry.get(voyager.id)
    record = space.papers.get(paper_id)
    if record is None:
        raise HTTPException(404, "File not found")
    key = f"papers/{paper_id}.pdf"
    stat = space.objects.stat(key)
    if stat is None:
        raise HTTPException(404, "File not found")

    filename = record.source_filename or record.filename
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "paper.pdf"
    headers = {
        "Content-Disposition": (
            f'inline; filename="{ascii_fallback}"; '
            f"filename*=UTF-8''{quote(filename)}"
        ),
        "Content-Length": str(stat.size_bytes),
    }
    return StreamingResponse(
        stream_object(space.objects.open(key)),
        media_type="application/pdf",
        headers=headers,
    )
