from __future__ import annotations
import asyncio
import json
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from backend.agents.curator import CuratorAgent
from backend.agents.librarian import LibrarianAgent
from backend.agents.master import MasterAgent
from backend.agents.oracle import OracleAgent
from backend.agents.status import StatusAgent
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
from backend.services.filesystem import FilesystemService
from backend.services.ocr import OCRService
from backend.services.similarity import top_k_neighbors
from backend.services.vectorstore import VectorStore
from backend.store import paper_store

# ── shared singletons ──────────────────────────────────────────────────────
_ocr_svc: OCRService
_embed_svc: EmbeddingService
_vstore: VectorStore
_fs_svc: FilesystemService
_oracle: OracleAgent
_librarian: LibrarianAgent
_status_agent: StatusAgent
_master: MasterAgent
_curator: CuratorAgent

# in-memory job registry  {job_id: asyncio.Queue}
_jobs: dict[str, asyncio.Queue] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ocr_svc, _embed_svc, _vstore, _fs_svc, _oracle, _librarian, _status_agent, _master, _curator
    settings.dbs_dir.mkdir(parents=True, exist_ok=True)
    settings.input_dir.mkdir(parents=True, exist_ok=True)
    settings.output_dir.mkdir(parents=True, exist_ok=True)

    init_db()  # dbs/orrery.db — users + sessions (Tier 2, phase 1)

    paper_store.load()

    _ocr_svc = OCRService()
    _embed_svc = EmbeddingService()
    _vstore = VectorStore(settings.chroma_persist_dir)
    _fs_svc = FilesystemService()
    _oracle = OracleAgent(_embed_svc, _vstore)
    _librarian = LibrarianAgent(_ocr_svc, _embed_svc, _vstore, _fs_svc)
    _status_agent = StatusAgent(_embed_svc, _vstore, _fs_svc)
    _master = MasterAgent(_oracle, _librarian, _status_agent)
    _curator = CuratorAgent()
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


# ── papers ─────────────────────────────────────────────────────────────────

@app.get("/api/papers", response_model=list[PaperRecord])
async def list_papers():
    return paper_store.all()


@app.get("/api/papers/{paper_id}/file")
async def get_paper_file(paper_id: str):
    record = paper_store.get(paper_id)
    if not record:
        raise HTTPException(404, "Paper not found")
    input_dir = settings.input_dir.resolve()
    path = Path(record.original_path).resolve()
    try:
        path.relative_to(input_dir)
    except ValueError:
        raise HTTPException(404, "File not found on disk") from None
    if not path.is_file():
        raise HTTPException(404, "File not found on disk")
    return FileResponse(
        str(path),
        media_type="application/pdf",
        filename=record.filename,
        content_disposition_type="inline",
    )


# ── tree ───────────────────────────────────────────────────────────────────

@app.get("/api/tree", response_model=TreeNode)
async def get_tree():
    return _fs_svc.get_tree_json(paper_store.as_dict())


# ── similarity / recommendations ────────────────────────────────────────────

@app.get("/api/similarity", response_model=dict[str, list[SimilarityNeighbor]])
async def get_similarity():
    ids, vectors = _vstore.get_all_paper_vectors()
    return top_k_neighbors(ids, vectors, k=6)


@app.get("/api/recommendations", response_model=list[Recommendation])
async def get_recommendations():
    return await _curator.recommend()


# ── chat ───────────────────────────────────────────────────────────────────

@app.patch("/api/papers/{paper_id}/status", response_model=PaperRecord)
async def update_paper_status(paper_id: str, body: StatusUpdateRequest):
    if body.status not in ("read", "toread"):
        raise HTTPException(400, "status must be 'read' or 'toread'")
    record = paper_store.get(paper_id)
    if not record:
        raise HTTPException(404, "Paper not found")
    if record.status == body.status:
        return record
    old_name       = record.symlink_name
    record.status  = body.status  # type: ignore[assignment]
    record.symlink_name = _fs_svc.make_symlink_name(record)
    if old_name:
        _fs_svc.update_symlink_status(record, old_name)
    _vstore.update_paper_status(paper_id, body.status)
    paper_store.save()
    return record


@app.post("/api/chat")
async def chat(body: ChatRequest):
    history = [{"role": m.role, "content": m.content} for m in body.history]

    async def generate() -> AsyncGenerator[str, None]:
        async for chunk in _master.run(body.message, history or None):
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── upload (two-step: POST → job_id, then GET SSE progress) ───────────────

@app.post("/api/papers/upload", response_model=UploadResponse)
async def upload_paper(file: UploadFile, status: str = Form("toread")):
    if file.content_type != "application/pdf" and not (file.filename or "").endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")
    if status not in ("read", "toread"):
        raise HTTPException(400, "status must be 'read' or 'toread'")

    # Always store real PDFs in input/ — output/ is a symlink tree
    dest_dir = settings.input_dir
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename or "upload.pdf").name
    dest = dest_dir / safe_name
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    job_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _jobs[job_id] = queue

    # Kick off ingest in background
    asyncio.create_task(_run_ingest(dest, status, queue))

    return UploadResponse(job_id=job_id)


async def _run_ingest(pdf_path: Path, status: str, queue: asyncio.Queue) -> None:
    def cb(step: str, pct: int) -> None:
        queue.put_nowait({"type": "progress", "step": step, "pct": pct})

    try:
        record = await _librarian.ingest(pdf_path, status, cb)
        queue.put_nowait({"type": "done", "paper": record.model_dump(mode="json")})
    except Exception as exc:
        queue.put_nowait({"type": "error", "message": str(exc)})


@app.post("/api/reindex")
async def reindex():
    async def generate() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue = asyncio.Queue()

        def cb(step: str, pct: int) -> None:
            queue.put_nowait({"type": "progress", "step": step, "pct": pct})

        task = asyncio.create_task(_run_reindex(cb, queue))

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


async def _run_reindex(cb, queue: asyncio.Queue) -> None:
    try:
        await _librarian.reindex(cb)
        queue.put_nowait({"type": "done"})
    except Exception as exc:
        queue.put_nowait({"type": "error", "message": str(exc)})


@app.get("/api/papers/upload/{job_id}/progress")
async def upload_progress(job_id: str):
    queue = _jobs.get(job_id)
    if not queue:
        raise HTTPException(404, "Job not found")

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
