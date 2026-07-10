from __future__ import annotations

import json
from typing import AsyncGenerator, BinaryIO
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from backend.auth.deps import get_db
from backend.auth.models import ROLE_KEEPER, User
from backend.auth.ratelimit import tour_chat_limiter
from backend.config import settings
from backend.models import ChatRequest, PaperRecord, SimilarityNeighbor, TourGalaxyResponse, TreeNode
from backend.services.similarity import top_k_neighbors
from backend.services.tree import build_tree
from backend.space import SpaceRegistry, UserSpace, get_space_registry

router = APIRouter(prefix="/api/tour", tags=["tour"])

_STREAM_CHUNK_SIZE = 1024 * 1024


def _object_key_for(paper_id: str) -> str:
    return f"papers/{paper_id}.pdf"


def _stream_object(stream: BinaryIO, chunk_size: int = _STREAM_CHUNK_SIZE):
    try:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        stream.close()


def _keeper_user(db: Session) -> User:
    keepers = db.exec(
        select(User).where(User.role == ROLE_KEEPER, User.disabled == False)  # noqa: E712
    ).all()
    if len(keepers) != 1:
        raise HTTPException(503, "Keeper galaxy unavailable")
    return keepers[0]


async def keeper_space(
    db: Session = Depends(get_db),
    registry: SpaceRegistry = Depends(get_space_registry),
) -> UserSpace:
    keeper = _keeper_user(db)
    return await registry.get_locked(keeper.id)


def _keeper_display_name(db: Session) -> str:
    return _keeper_user(db).display_name


@router.get("/galaxy", response_model=TourGalaxyResponse)
async def get_tour_galaxy(
    db: Session = Depends(get_db),
    space: UserSpace = Depends(keeper_space),
):
    papers = space.papers.all()
    return TourGalaxyResponse(
        display_name=_keeper_display_name(db),
        stars=len(papers),
        ignited=sum(1 for paper in papers if paper.status == "read"),
        constellations=len({paper.cluster_path.split("/")[0] for paper in papers if paper.cluster_path}),
    )


@router.get("/papers", response_model=list[PaperRecord])
async def list_tour_papers(space: UserSpace = Depends(keeper_space)):
    return space.papers.all()


@router.get("/tree", response_model=TreeNode)
async def get_tour_tree(space: UserSpace = Depends(keeper_space)):
    return build_tree(space.papers.as_dict())


@router.get("/similarity", response_model=dict[str, list[SimilarityNeighbor]])
async def get_tour_similarity(space: UserSpace = Depends(keeper_space)):
    ids, vectors = space.vstore.get_all_paper_vectors()
    return top_k_neighbors(ids, vectors, k=6)


@router.get("/papers/{paper_id}/file")
async def get_tour_paper_file(paper_id: str, space: UserSpace = Depends(keeper_space)):
    record = space.papers.get(paper_id)
    if not record:
        raise HTTPException(404, "Paper not found")

    key = _object_key_for(paper_id)
    stat = space.objects.stat(key)
    if stat is None:
        raise HTTPException(404, "File not found in object store")

    stream = space.objects.open(key)
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
        _stream_object(stream),
        media_type="application/pdf",
        headers=headers,
    )


@router.post("/chat")
async def tour_chat(
    body: ChatRequest,
    request: Request,
    space: UserSpace = Depends(keeper_space),
):
    if not settings.tour_chat_enabled:
        raise HTTPException(503, "Tour chat is disabled")
    client_host = request.client.host if request.client else "unknown"
    if not tour_chat_limiter.allow(client_host):
        raise HTTPException(429, "Too many tour chat requests")

    async def generate() -> AsyncGenerator[str, None]:
        try:
            async for chunk in space.oracle.stream(body.message):
                yield chunk
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
