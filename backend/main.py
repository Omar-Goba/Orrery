from __future__ import annotations
import asyncio
import hashlib
import json
import tempfile
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncGenerator, BinaryIO
from urllib.parse import quote

from fastapi import Depends, FastAPI, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from backend.auth.db import init_db
from backend.auth.router import router as auth_router
from backend.config import settings
from backend.models import (
    ChatRequest,
    PaperRecord,
    Recommendation,
    SimilarityNeighbor,
    StatusUpdateRequest,
    TreeNode,
    UploadResponse,
)
from backend.services.embeddings import EmbeddingService
from backend.services.objectstore import LocalObjectStore, ObjectStore
from backend.services.ocr import OCRService
from backend.services.similarity import top_k_neighbors
from backend.services.tree import build_tree
from backend.services.vectorstore import VectorStore
from backend.space import SpaceRegistry, UserSpace, current_space
from backend.tour import router as tour_router

# ── shared singletons ──────────────────────────────────────────────────────
_ocr_svc: OCRService
_embed_svc: EmbeddingService
_object_store: ObjectStore


@dataclass
class UploadJob:
    user_id: str
    queue: asyncio.Queue


# in-memory job registry  {job_id: UploadJob}
_jobs: dict[str, UploadJob] = {}

_UPLOAD_CHUNK_SIZE = 1024 * 1024  # 1 MiB


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ocr_svc, _embed_svc, _object_store
    settings.dbs_dir.mkdir(parents=True, exist_ok=True)
    _jobs.clear()

    init_db()  # dbs/orrery.db — users + sessions (Tier 2, phase 1)

    _ocr_svc = OCRService()
    _embed_svc = EmbeddingService()
    # One shared Chroma client for the whole process (plan §4.2/§4.4). Every
    # per-user `VectorStore` built by `SpaceRegistry` uses this same client,
    # never a client per user.
    _chroma_client = VectorStore.build_client(settings.chroma_persist_dir)
    _object_store = LocalObjectStore(settings.objects_dir)

    app.state.space_registry = SpaceRegistry(
        chroma_client=_chroma_client,
        object_store=_object_store,
        ocr_svc=_ocr_svc,
        embed_svc=_embed_svc,
    )
    yield


app = FastAPI(title="Project Library", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.include_router(auth_router)
app.include_router(tour_router)


def _object_key_for(paper_id: str) -> str:
    return f"papers/{paper_id}.pdf"


def _stream_object(stream: BinaryIO, chunk_size: int = _UPLOAD_CHUNK_SIZE):
    """Read an ObjectStore stream in fixed-size chunks, closing it when done.

    Never `FileResponse(path)` — this is the streaming seam that makes the
    PDF-serving route MinIO-ready and lets a future authz layer sit in front
    of it without touching how bytes actually move (plan §10.1 rule #3).
    """
    try:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        stream.close()


# ── papers ─────────────────────────────────────────────────────────────────

@app.get("/api/papers", response_model=list[PaperRecord])
async def list_papers(space: UserSpace = Depends(current_space)):
    return space.papers.all()


@app.get("/api/papers/{paper_id}/file")
async def get_paper_file(paper_id: str, space: UserSpace = Depends(current_space)):
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


@app.delete("/api/papers/{paper_id}", status_code=204)
async def delete_paper(paper_id: str, space: UserSpace = Depends(current_space)):
    record = space.papers.get(paper_id)
    if not record:
        raise HTTPException(404, "Paper not found")

    key = _object_key_for(paper_id)
    space.objects.delete(key)
    space.vstore.delete_paper(paper_id)
    space.papers.delete(paper_id)
    await space.papers.save()
    return Response(status_code=204)


# ── tree ───────────────────────────────────────────────────────────────────

@app.get("/api/tree", response_model=TreeNode)
async def get_tree(space: UserSpace = Depends(current_space)):
    return build_tree(space.papers.as_dict())


# ── similarity / recommendations ────────────────────────────────────────────

@app.get("/api/similarity", response_model=dict[str, list[SimilarityNeighbor]])
async def get_similarity(space: UserSpace = Depends(current_space)):
    ids, vectors = space.vstore.get_all_paper_vectors()
    return top_k_neighbors(ids, vectors, k=6)


@app.get("/api/recommendations", response_model=list[Recommendation])
async def get_recommendations(space: UserSpace = Depends(current_space)):
    return await space.curator.recommend()


# ── chat ───────────────────────────────────────────────────────────────────

@app.patch("/api/papers/{paper_id}/status", response_model=PaperRecord)
async def update_paper_status(
    paper_id: str,
    body: StatusUpdateRequest,
    space: UserSpace = Depends(current_space),
):
    if body.status not in ("read", "toread"):
        raise HTTPException(400, "status must be 'read' or 'toread'")
    record = space.papers.get(paper_id)
    if not record:
        raise HTTPException(404, "Paper not found")
    if record.status == body.status:
        return record
    # No disk mutation — the tree is a pure function of records.
    record.status = body.status  # type: ignore[assignment]
    space.vstore.update_paper_status(paper_id, body.status)
    await space.papers.save()
    return record


@app.post("/api/chat")
async def chat(body: ChatRequest, space: UserSpace = Depends(current_space)):
    history = [{"role": m.role, "content": m.content} for m in body.history]

    async def generate() -> AsyncGenerator[str, None]:
        async for chunk in space.master.run(body.message, history or None):
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── upload (two-step: POST → job_id, then GET SSE progress) ───────────────

@app.post("/api/papers/upload", response_model=UploadResponse)
async def upload_paper(
    file: UploadFile,
    status: str = Form("toread"),
    space: UserSpace = Depends(current_space),
):
    if file.content_type != "application/pdf" and not (file.filename or "").endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")
    if status not in ("read", "toread"):
        raise HTTPException(400, "status must be 'read' or 'toread'")

    source_filename = Path(file.filename or "upload.pdf").name

    # Hash incrementally while spooling to a scratch tempfile — never buffer
    # the whole upload in memory, and the content hash IS the paper id
    # (plan §4.3), so we don't know the final object key until this loop
    # finishes.
    hasher = hashlib.sha256()
    size = 0
    tmp_fd, tmp_name = tempfile.mkstemp(prefix=".upload-", suffix=".part")
    tmp_path = Path(tmp_name)
    try:
        with open(tmp_fd, "wb") as spool:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                if size > settings.max_pdf_bytes:
                    raise HTTPException(413, "PDF exceeds the maximum allowed size")
                hasher.update(chunk)
                spool.write(chunk)

        paper_id = hasher.hexdigest()[:16]

        existing = space.papers.get(paper_id)
        if existing is not None:
            # Content-hash dedup (plan §4.3): identical bytes are a 409 with
            # the existing record, never a silent overwrite.
            return JSONResponse(
                status_code=409,
                content={
                    "error": "duplicate",
                    "paper": existing.model_dump(mode="json"),
                },
            )

        key = _object_key_for(paper_id)
        with open(tmp_path, "rb") as spooled:
            space.objects.put(key, spooled, max_bytes=settings.max_pdf_bytes)
    finally:
        tmp_path.unlink(missing_ok=True)

    job_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _jobs[job_id] = UploadJob(user_id=space.user_id, queue=queue)

    # Kick off ingest in background
    asyncio.create_task(_run_ingest(space, paper_id, key, source_filename, status, queue))

    return UploadResponse(job_id=job_id)


async def _run_ingest(
    space: UserSpace,
    paper_id: str,
    key: str,
    source_filename: str,
    status: str,
    queue: asyncio.Queue,
) -> None:
    def cb(step: str, pct: int) -> None:
        queue.put_nowait({"type": "progress", "step": step, "pct": pct})

    try:
        record = await space.librarian.ingest(paper_id, key, source_filename, status, cb)
        queue.put_nowait({"type": "done", "paper": record.model_dump(mode="json")})
    except Exception as exc:
        # Failure hygiene (plan §9): don't leak the object if ingest blows
        # up after the bytes already landed.
        space.objects.delete(key)
        queue.put_nowait({"type": "error", "message": str(exc)})


@app.post("/api/reindex")
async def reindex(space: UserSpace = Depends(current_space)):
    async def generate() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue = asyncio.Queue()

        def cb(step: str, pct: int) -> None:
            queue.put_nowait({"type": "progress", "step": step, "pct": pct})

        task = asyncio.create_task(_run_reindex(space, cb, queue))

        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                break

        await task

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run_reindex(space: UserSpace, cb, queue: asyncio.Queue) -> None:
    try:
        await space.librarian.reindex(cb)
        queue.put_nowait({"type": "done"})
    except Exception as exc:
        queue.put_nowait({"type": "error", "message": str(exc)})


@app.get("/api/papers/upload/{job_id}/progress")
async def upload_progress(job_id: str, space: UserSpace = Depends(current_space)):
    job = _jobs.get(job_id)
    if not job or job.user_id != space.user_id:
        raise HTTPException(404, "Job not found")
    queue = job.queue

    async def generate() -> AsyncGenerator[str, None]:
        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                _jobs.pop(job_id, None)
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
