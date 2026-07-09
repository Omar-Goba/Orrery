from __future__ import annotations
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field


PaperStatus = Literal["read", "toread"]


class PaperRecord(BaseModel):
    id: str
    filename: str
    original_path: str
    status: PaperStatus
    title: str | None = None
    author: str | None = None
    year: str | None = None
    summary: str | None = None
    cluster_path: str | None = None
    symlink_name: str | None = None
    ingested_at: datetime | None = None
    ocr_cached: bool = False


class ChunkRecord(BaseModel):
    paper_id: str
    chunk_index: int
    text: str
    token_count: int


class Citation(BaseModel):
    paper_id: str
    author: str
    year: str
    title: str
    cluster_path: str | None = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class StatusUpdateRequest(BaseModel):
    status: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


class TreeNode(BaseModel):
    name: str
    type: Literal["folder", "paper"]
    paper_id: str | None = None
    status: PaperStatus | None = None
    title: str | None = None
    author: str | None = None
    year: str | None = None
    filename: str | None = None
    children: list[TreeNode] = Field(default_factory=list)


class UploadResponse(BaseModel):
    job_id: str


class ProgressEvent(BaseModel):
    type: Literal["progress", "done", "error"]
    step: str | None = None
    pct: int | None = None
    paper: PaperRecord | None = None
    message: str | None = None


class SimilarityNeighbor(BaseModel):
    id: str
    score: float


class Recommendation(BaseModel):
    paper_id: str
    title: str
    author: str | None = None
    year: str | None = None
    cluster_path: str | None = None
    reason: str
