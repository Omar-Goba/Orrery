from __future__ import annotations
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field


PaperStatus = Literal["read", "toread"]


class PaperRecord(BaseModel):
    id: str
    filename: str
    source_filename: str
    status: PaperStatus
    title: str | None = None
    author: str | None = None
    year: str | None = None
    summary: str | None = None
    cluster_path: str | None = None
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


class QuotaExceededResponse(BaseModel):
    error: Literal["quota_exceeded"]
    used: int
    quota: int


class FileTooLargeResponse(BaseModel):
    error: Literal["file_too_large"]
    max_bytes: int


class VoyagerStorageSummary(BaseModel):
    handle: str
    display_name: str
    created_at: datetime
    paper_count: int
    storage_used_bytes: int
    storage_quota_bytes: int
    disabled: bool


class StoredFileEntry(BaseModel):
    paper_id: str
    filename: str
    size_bytes: int
    uploaded_at: datetime


class QuotaPatchRequest(BaseModel):
    storage_quota_bytes: int = Field(ge=0)


class ProgressEvent(BaseModel):
    type: Literal["progress", "done", "error"]
    step: str | None = None
    pct: int | None = None
    paper: PaperRecord | None = None
    message: str | None = None


class SimilarityNeighbor(BaseModel):
    id: str
    score: float


class TourGalaxyResponse(BaseModel):
    display_name: str
    stars: int
    ignited: int
    constellations: int


class Recommendation(BaseModel):
    paper_id: str
    title: str
    author: str | None = None
    year: str | None = None
    cluster_path: str | None = None
    reason: str
