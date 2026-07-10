from __future__ import annotations
import asyncio
import hashlib
import tempfile
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncGenerator
from urllib.parse import quote

from fastapi import Depends, FastAPI, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from loguru import logger

from backend.auth.ratelimit import client_log_limiter
from backend.auth.db import init_db
from backend.auth.router import router as auth_router
from backend.accounting import (
    QuotaExceeded,
    decrement_storage_used,
    ensure_can_store,
    get_storage_snapshot,
    increment_storage_used,
)
from backend.config import settings
from backend.keeper import router as keeper_router
from backend.middleware import RequestIDMiddleware
from backend.models import (
    ChatRequest,
    ClientLogRequest,
    PaperRecord,
    Recommendation,
    SimilarityNeighbor,
    StatusUpdateRequest,
    TreeNode,
    UploadResponse,
)
from backend.services.embeddings import EmbeddingService
from backend.services.embedder_registry import (
    EmbedderIdentity,
    load_embedder_identity,
    save_embedder_identity,
)
from backend.services.objectstore import LocalObjectStore, ObjectSizeLimitExceeded, ObjectStore
from backend.services.logging_setup import configure_logging
from backend.services.reembed_job import ReembedJob
from backend.services.retrieval_defaults import MAIN_NEIGHBOR_K
from backend.services.ocr import OCRService
from backend.services.similarity import top_k_neighbors
from backend.services.sse import sse
from backend.services.streaming import CHUNK_SIZE, stream_object
from backend.services.tree import build_tree
from backend.services.vectorstore import VectorStore
from backend.space import (
    SpaceRegistry,
    UserSpace,
    current_space,
    get_space_registry,
    wait_for_ingest_gate,
)
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_dir, settings.log_level)
    global _ocr_svc, _embed_svc, _object_store
    logger.info("Backend startup begins")
    settings.dbs_dir.mkdir(parents=True, exist_ok=True)
    _jobs.clear()

    init_db()  # dbs/orrery.db — users + sessions (Tier 2, phase 1)

    _ocr_svc = OCRService()
    _embed_svc = EmbeddingService()
    embed_dim = await _embed_svc.verify()
    current_identity = EmbedderIdentity.current(
        settings.llm_embedder,
        embed_dim,
        active_persist_dir=settings.chroma_persist_dir,
    )
    previous_identity = load_embedder_identity(settings.chroma_persist_dir)
    active_chroma_dir = settings.chroma_persist_dir
    if previous_identity is None:
        save_embedder_identity(settings.chroma_persist_dir, current_identity)
    else:
        active_chroma_dir = previous_identity.active_path(settings.chroma_persist_dir)
        if previous_identity.same_embedder(current_identity):
            if previous_identity.dim != current_identity.dim:
                raise RuntimeError(
                    "Embedding dimension drift for unchanged embedder "
                    f"{current_identity.base_url} {current_identity.model}: "
                    f"recorded={previous_identity.dim} current={current_identity.dim}"
                )
        else:
            logger.warning(
                "Embedder identity changed from base_url={} model={} dim={} to base_url={} model={} dim={}; startup will continue on the old store while re-embed runs",
                previous_identity.base_url,
                previous_identity.model,
                previous_identity.dim,
                current_identity.base_url,
                current_identity.model,
                current_identity.dim,
            )
    # One shared Chroma client for the whole process (plan §4.2/§4.4). Every
    # per-user `VectorStore` built by `SpaceRegistry` uses this same client,
    # never a client per user.
    _chroma_client = VectorStore.build_client(active_chroma_dir)
    _object_store = LocalObjectStore(settings.objects_dir)

    app.state.space_registry = SpaceRegistry(
        chroma_client=_chroma_client,
        object_store=_object_store,
        ocr_svc=_ocr_svc,
        embed_svc=_embed_svc,
    )
    if previous_identity is not None and not previous_identity.same_embedder(current_identity):
        app.state.reembed_task = asyncio.create_task(
            ReembedJob(
                registry=app.state.space_registry,
                old_client=_chroma_client,
                old_persist_dir=active_chroma_dir,
                embed_svc=_embed_svc,
                new_identity=current_identity,
                chroma_persist_dir=settings.chroma_persist_dir,
            ).run()
        )
    logger.info("Backend startup complete")
    yield


app = FastAPI(title="Project Library", lifespan=lifespan)

app.add_middleware(RequestIDMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.include_router(auth_router)
app.include_router(tour_router)
app.include_router(keeper_router)


def _object_key_for(paper_id: str) -> str:
    return f"papers/{paper_id}.pdf"


def _quota_response(exc: QuotaExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=507,
        content={
            "error": "quota_exceeded",
            "used": exc.snapshot.used,
            "quota": exc.snapshot.quota,
        },
    )


def _file_too_large_response() -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={"error": "file_too_large", "max_bytes": settings.max_pdf_bytes},
    )


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
        stream_object(stream),
        media_type="application/pdf",
        headers=headers,
    )


@app.delete("/api/papers/{paper_id}", status_code=204)
async def delete_paper(paper_id: str, space: UserSpace = Depends(current_space)):
    record = space.papers.get(paper_id)
    if not record:
        raise HTTPException(404, "Paper not found")

    key = _object_key_for(paper_id)
    stat = space.objects.stat(key)
    space.objects.delete(key)
    if stat is not None:
        decrement_storage_used(space.user_id, stat.size_bytes)
    space.vstore.delete_paper(paper_id)
    space.papers.delete(paper_id)
    await space.papers.save()
    logger.info("Paper deleted user_id={} paper_id={}", space.user_id, paper_id)
    return Response(status_code=204)


# ── tree ───────────────────────────────────────────────────────────────────

@app.get("/api/tree", response_model=TreeNode)
async def get_tree(space: UserSpace = Depends(current_space)):
    return build_tree(space.papers.as_dict())


# ── similarity / recommendations ────────────────────────────────────────────

@app.get("/api/similarity", response_model=dict[str, list[SimilarityNeighbor]])
async def get_similarity(space: UserSpace = Depends(current_space)):
    ids, vectors = space.vstore.get_all_paper_vectors()
    return top_k_neighbors(ids, vectors, k=MAIN_NEIGHBOR_K)


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
    logger.info("Paper status updated user_id={} paper_id={} status={}", space.user_id, paper_id, body.status)
    return record


@app.post("/api/client-log", status_code=204)
async def client_log(body: ClientLogRequest, request: Request) -> Response:
    client_host = request.client.host if request.client else "unknown"
    if not client_log_limiter.allow(client_host):
        raise HTTPException(429, "Too many client log events")
    sink = logger.warning if body.level == "warning" else logger.error
    sink(
        "Client log source=frontend level={} url={} message={} stack={}",
        body.level,
        body.url,
        body.message,
        body.stack or "",
    )
    return Response(status_code=204)


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
    _gate: None = Depends(wait_for_ingest_gate),
    registry: SpaceRegistry = Depends(get_space_registry),
    space: UserSpace = Depends(current_space),
):
    if file.content_type != "application/pdf" and not (file.filename or "").endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")
    if status not in ("read", "toread"):
        raise HTTPException(400, "status must be 'read' or 'toread'")

    source_filename = Path(file.filename or "upload.pdf").name
    snapshot = get_storage_snapshot(space.user_id)
    file_content_length = file.headers.get("content-length")
    if file_content_length is not None:
        try:
            content_length_bytes = int(file_content_length)
        except ValueError:
            content_length_bytes = 0
        if content_length_bytes > settings.max_pdf_bytes:
            return _file_too_large_response()
        if content_length_bytes > snapshot.remaining:
            return _quota_response(QuotaExceeded(snapshot))

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
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                if size > settings.max_pdf_bytes:
                    return _file_too_large_response()
                if size > snapshot.remaining:
                    return _quota_response(QuotaExceeded(snapshot))
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
            try:
                ensure_can_store(space.user_id, size)
                written = space.objects.put(
                    key,
                    spooled,
                    max_bytes=min(settings.max_pdf_bytes, snapshot.remaining),
                )
                increment_storage_used(space.user_id, written)
            except QuotaExceeded as exc:
                space.objects.delete(key)
                return _quota_response(exc)
            except ObjectSizeLimitExceeded:
                space.objects.delete(key)
                return _file_too_large_response()
    finally:
        tmp_path.unlink(missing_ok=True)

    job_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _jobs[job_id] = UploadJob(user_id=space.user_id, queue=queue)
    logger.info(
        "Upload accepted user_id={} paper_id={} job_id={} filename={} size_bytes={}",
        space.user_id,
        paper_id,
        job_id,
        source_filename,
        size,
    )

    # Kick off ingest in background
    asyncio.create_task(
        _run_ingest(registry, space.user_id, paper_id, key, source_filename, status, queue)
    )

    return UploadResponse(job_id=job_id)


async def _run_ingest(
    registry: SpaceRegistry,
    user_id: str,
    paper_id: str,
    key: str,
    source_filename: str,
    status: str,
    queue: asyncio.Queue,
) -> None:
    def cb(step: str, pct: int) -> None:
        queue.put_nowait({"type": "progress", "step": step, "pct": pct})

    space: UserSpace | None = None
    try:
        await registry.wait_for_ingest_allowed()
        space = await registry.get_locked(user_id)
        logger.info("Ingest started user_id={} paper_id={}", space.user_id, paper_id)
        record = await space.librarian.ingest(paper_id, key, source_filename, status, cb)
        logger.info("Ingest finished user_id={} paper_id={}", space.user_id, paper_id)
        queue.put_nowait({"type": "done", "paper": record.model_dump(mode="json")})
    except Exception as exc:
        logger.exception("Ingest failed user_id={} paper_id={}", user_id, paper_id)
        # Failure hygiene (plan §9): don't leak the object if ingest blows
        # up after the bytes already landed.
        if space is not None:
            stat = space.objects.stat(key)
            space.objects.delete(key)
            if stat is not None:
                decrement_storage_used(space.user_id, stat.size_bytes)
        queue.put_nowait({"type": "error", "message": str(exc)})


@app.post("/api/reindex")
async def reindex(
    _gate: None = Depends(wait_for_ingest_gate),
    space: UserSpace = Depends(current_space),
):
    async def generate() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue = asyncio.Queue()

        def cb(step: str, pct: int) -> None:
            queue.put_nowait({"type": "progress", "step": step, "pct": pct})

        task = asyncio.create_task(_run_reindex(space, cb, queue))

        while True:
            event = await queue.get()
            yield sse(event)
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
        logger.info("Reindex started user_id={}", space.user_id)
        await space.librarian.reindex(cb)
        logger.info("Reindex finished user_id={}", space.user_id)
        queue.put_nowait({"type": "done"})
    except Exception as exc:
        logger.exception("Reindex failed user_id={}", space.user_id)
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
            yield sse(event)
            if event["type"] in ("done", "error"):
                _jobs.pop(job_id, None)
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
