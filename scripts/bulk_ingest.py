#!/usr/bin/env python3
"""Bootstrap all existing PDFs into the library.

Usage:
    python scripts/bulk_ingest.py          # full run
    python scripts/bulk_ingest.py --dry-run  # preview only
    python scripts/bulk_ingest.py --reset    # clear Chroma + papers.json and start fresh
    python scripts/bulk_ingest.py --revector # update paper vectors from summaries only

Phase 2 (ObjectStore + virtual tree) note: this script is a legacy bulk
importer for PDFs dropped directly into `dbs/input/`. It writes every
imported PDF's bytes through the `ObjectStore` under a content-hash key —
same as the live `/api/papers/upload` endpoint — rather than leaving them
where they land on disk. `dbs/output/` (the old symlink forest) is no
longer read or written anywhere; `GET /api/tree` is a pure function of the
records, computed live, so there is nothing left here to "finalize" onto
disk.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Make sure we can import from project root
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

from dotenv import load_dotenv
load_dotenv()

from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn, TimeRemainingColumn

from backend.config import settings
from backend.clustering.hierarchical import HierarchicalClusterer
from backend.clustering.namer import ClusterNamer
from backend.models import ChunkRecord, PaperRecord
from backend.services.embeddings import EmbeddingService
from backend.services.objectstore import LocalObjectStore, ObjectStore
from backend.services.ocr import OCRService
from backend.services.summarize import SummaryService, front_matter_text
from backend.services.vectorstore import VectorStore
from backend.store import PaperStore

console = Console()
MAX_CHARS = 2000
OVERLAP_CHARS = 150

# Legacy drop-folder for this CLI tool only — the live API never reads a
# path like this; it goes straight from an upload stream into the
# ObjectStore. This constant is intentionally local to the script, not on
# `Settings`, so nothing in `backend/` can be tempted to reach for it.
LEGACY_INPUT_DIR = ROOT / "dbs" / "input"


def _object_key_for(paper_id: str) -> str:
    return f"papers/{paper_id}.pdf"


def _hash_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()[:16]


class _ScratchCopy:
    """Copies an ObjectStore object out to a throwaway tempfile so pypdf has
    a real local path to open, cleaning up on exit (plan §10.1 rule #4)."""

    def __init__(self, store: ObjectStore, key: str) -> None:
        self._store = store
        self._key = key
        self._path: Path | None = None

    def __enter__(self) -> Path:
        fd, name = tempfile.mkstemp(suffix=".pdf")
        self._path = Path(name)
        with open(fd, "wb") as tmp, self._store.open(self._key) as src:
            shutil.copyfileobj(src, tmp)
        return self._path

    def __exit__(self, *exc_info: object) -> None:
        if self._path is not None:
            self._path.unlink(missing_ok=True)


def chunk_text(text: str) -> list[str]:
    if not text:
        return [""]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + MAX_CHARS
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - OVERLAP_CHARS
    return chunks


_SKIP_TITLE = re.compile(
    r"https?://|see discussions|researchgate\.net|arxiv\.org|doi\.org|"
    r"all rights reserved|©\s*\d{4}|open access|preprint|under review|"
    r"published in|proceedings of|workshop on|symposium on|"
    r"permits use|permitted use|creative commons|attribution|reproduction in any|"
    r"regulation or exceeds|obtain permission|^\s*arxiv:\d",
    re.IGNORECASE,
)
_FALSE_AUTHOR = {
    # Structure / boilerplate
    "Abstract", "Introduction", "Conclusion", "Related", "The", "All", "This",
    "Open", "Access", "Published", "Conference", "Proceedings", "Journal",
    "Under", "Review", "Submitted", "Figure", "Table", "Section", "Appendix",
    "References", "Background", "Method", "Approach", "System", "Based",
    "Creative", "Commons", "Permits", "Attribution", "Correspondence",
    # ML / AI domain words that appear in paper bodies
    "Neural", "Deep", "Learning", "Language", "Large", "Vision", "Graph",
    "Multi", "Agent", "Model", "Network", "Training", "Inference", "Data",
    "Sentiment", "Robot", "Develop", "Engineering", "Research", "Paper",
    "Scalable", "Adaptive", "Hierarchical", "Framework", "Benchmark",
    "Evaluation", "Analysis", "Study", "Survey", "Generative",
}


def extract_metadata(text: str, filename: str) -> tuple[str | None, str | None, str | None]:
    year_m = re.search(r"\b(19|20)\d{2}\b", text[:2000])
    year = year_m.group(0) if year_m else None

    lines = [l.strip() for l in text[:5000].splitlines() if l.strip()]

    title_idx = None
    title = None
    for i, line in enumerate(lines[:25]):
        if len(line) < 8 or len(line) > 200:
            continue
        if len(line.split()) < 3:
            continue
        if _SKIP_TITLE.search(line):
            continue
        if re.search(r"\d+:\d+", line):
            continue
        title = re.sub(r'\b([A-Z])\s+([A-Z]{2,})', r'\1\2', line)[:150]
        title_idx = i
        break
    if not title:
        title = Path(filename).stem.replace("_", " ").replace("-", " ")

    if title and title_idx is not None and re.search(
        r'(?:\b(for|in|of|with|the|an?|and|or|by|to|on|at|as|via|from)|:)\s*$', title, re.I
    ):
        for j in range(title_idx + 1, min(title_idx + 3, len(lines))):
            ext = lines[j]
            if ext and not _SKIP_TITLE.search(ext) and not re.search(r'\d+:\d+', ext):
                title = (title.rstrip() + " " + ext)[:150]
                break

    start = (title_idx + 1) if title_idx is not None else 1
    author_last = None
    for m in re.finditer(
        r"\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b",
        "\n".join(lines[start : start + 10]),
    ):
        if m.group(1) not in _FALSE_AUTHOR:
            author_last = m.group(1)
            break

    return title, author_last, year


async def paper_vector_for(
    text: str,
    filename: str,
    title: str | None,
    summary: str | None,
    embed_svc: EmbeddingService,
) -> list[float]:
    if summary:
        return await embed_svc.embed_text(f"{title or filename}\n\n{summary}")
    front = front_matter_text(text) or (title or filename)
    return embed_svc.paper_vector(await embed_svc.embed_batch(chunk_text(front)))


async def summarize_metadata(
    text: str,
    filename: str,
    summary_svc: SummaryService,
) -> tuple[str | None, str | None, str | None, str | None]:
    fallback_title, fallback_author, fallback_year = extract_metadata(text, Path(filename).stem)
    summary_result = await summary_svc.summarize(text, filename)
    return (
        summary_result.title or fallback_title,
        summary_result.author_last or fallback_author,
        summary_result.year or fallback_year,
        summary_result.summary,
    )


async def process_one(
    pdf_path: Path,
    status: str,
    ocr_svc: OCRService,
    embed_svc: EmbeddingService,
    summary_svc: SummaryService,
    vstore: VectorStore,
    store: PaperStore,
    object_store: ObjectStore,
    dry_run: bool,
    progress: Progress,
    task_id,
) -> PaperRecord | None:
    paper_id = _hash_file(pdf_path)

    if vstore.paper_exists(paper_id):
        progress.advance(task_id)
        progress.log(f"[dim]skip (already ingested):[/dim] {pdf_path.name}")
        return store.get(paper_id)

    if dry_run:
        progress.advance(task_id)
        progress.log(f"[cyan]would ingest:[/cyan] {pdf_path.name} [{status}]")
        return None

    source_filename = pdf_path.name
    key = _object_key_for(paper_id)

    try:
        text = await ocr_svc.extract(pdf_path, cache_key=paper_id)
        if not text.strip():
            progress.log(f"[yellow]warn: empty OCR for {source_filename}[/yellow]")
            text = pdf_path.stem.replace("_", " ")

        title, author, year, summary = await summarize_metadata(text, source_filename, summary_svc)
        chunks = chunk_text(text)
        chunk_vecs = await embed_svc.embed_batch(chunks)
        paper_vec = await paper_vector_for(text, source_filename, title, summary, embed_svc)

        # Bytes land in the ObjectStore the same way the live upload
        # endpoint does it — no `dbs/input/` filesystem path is ever
        # persisted onto the record.
        with open(pdf_path, "rb") as f:
            object_store.put(key, f, max_bytes=settings.max_pdf_bytes)

        chunk_records = [
            ChunkRecord(paper_id=paper_id, chunk_index=i, text=c, token_count=len(c) // 4)
            for i, c in enumerate(chunks)
        ]
        vstore.add_chunks(paper_id, chunk_records, chunk_vecs)
        vstore.upsert_paper_vector(
            paper_id, paper_vec,
            {"filename": source_filename, "status": status,
             "source_filename": source_filename,
             "title": title or "", "author": author or "", "year": year or "",
             "summary": summary or ""},
        )

        record = PaperRecord(
            id=paper_id, filename=source_filename,
            source_filename=source_filename,
            status=status,  # type: ignore[arg-type]
            title=title, author=author, year=year, summary=summary, ocr_cached=True,
            ingested_at=datetime.now(timezone.utc),
        )
        store.put(record)
        progress.advance(task_id)
        return record

    except Exception as exc:
        progress.log(f"[red]ERROR {source_filename}:[/red] {exc}")
        object_store.delete(key)  # failure hygiene — don't leak the bytes
        err_file = ROOT / "bulk_ingest_errors.jsonl"
        with open(err_file, "a") as f:
            f.write(json.dumps({"file": str(pdf_path), "error": str(exc)}) + "\n")
        progress.advance(task_id)
        return None


async def revector_one(
    record: PaperRecord,
    ocr_svc: OCRService,
    embed_svc: EmbeddingService,
    summary_svc: SummaryService,
    vstore: VectorStore,
    store: PaperStore,
    object_store: ObjectStore,
    dry_run: bool,
    progress: Progress,
    task_id,
) -> PaperRecord | None:
    key = _object_key_for(record.id)

    if dry_run:
        progress.advance(task_id)
        progress.log(f"[cyan]would revector:[/cyan] {record.filename}")
        return record

    try:
        with _ScratchCopy(object_store, key) as pdf_path:
            text = await ocr_svc.extract(pdf_path, cache_key=record.id)
        if not text.strip():
            progress.log(f"[yellow]warn: empty OCR for {record.filename}[/yellow]")
            text = record.filename.replace("_", " ")

        title, author, year, summary = await summarize_metadata(text, record.filename, summary_svc)
        paper_vec = await paper_vector_for(text, record.filename, title, summary, embed_svc)
        vstore.upsert_paper_vector(
            record.id,
            paper_vec,
            {"filename": record.filename, "status": record.status,
             "source_filename": record.source_filename,
             "title": title or "", "author": author or "", "year": year or "",
             "summary": summary or ""},
        )

        record.title = title
        record.author = author
        record.year = year
        record.summary = summary
        record.ocr_cached = True
        store.put(record)
        progress.advance(task_id)
        return record

    except Exception as exc:
        progress.log(f"[red]ERROR {record.filename}:[/red] {exc}")
        err_file = ROOT / "bulk_ingest_errors.jsonl"
        with open(err_file, "a") as f:
            f.write(json.dumps({"file": record.source_filename, "error": str(exc)}) + "\n")
        progress.advance(task_id)
        return None


async def finalize_library(
    vstore: VectorStore,
    store: PaperStore,
    clusterer: HierarchicalClusterer,
    namer: ClusterNamer,
) -> None:
    console.print("\nClustering papers…")
    paper_ids, vectors = vstore.get_all_paper_vectors()
    if not paper_ids:
        console.print("[yellow]No papers in vector store — skipping clustering.[/yellow]")
        return

    tree = clusterer.cluster(paper_ids, vectors)
    console.print(f"Found [bold]{len(tree)}[/bold] top-level clusters")

    console.print("Naming cluster tree…")
    with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as p2:
        name_task = p2.add_task("Naming…", total=None)
        await namer.name_tree(tree, store.as_dict())
        p2.advance(name_task)

    def assign_paths(nodes: list, prefix: str = "") -> None:
        for node in nodes:
            path = f"{prefix}/{node.name}" if prefix else node.name
            if node.is_leaf:
                for pid in node.paper_ids:
                    r = store.get(pid)
                    if r:
                        r.cluster_path = path
            else:
                assign_paths(node.children, path)

    assign_paths(tree)
    store.save()

    console.print(f"\n[bold green]Done![/bold green] {len(store)} papers in library.")
    console.print(
        "Tree is computed live by GET /api/tree from the records — "
        "no output/ folder to rebuild."
    )

    def print_tree(nodes: list, indent: int = 0) -> None:
        prefix = "  " * indent
        for node in nodes:
            if node.is_leaf:
                console.print(f"{prefix}[dim]({len(node.paper_ids)} papers)[/dim]")
            else:
                console.print(f"{prefix}[bold]{node.name}[/bold]/")
                print_tree(node.children, indent + 1)

    print_tree(tree)


async def main(dry_run: bool, reset: bool, revector: bool) -> None:
    if reset and revector:
        raise SystemExit("--reset and --revector cannot be used together")

    if reset and not dry_run:
        console.print("[bold red]Resetting Chroma and papers.json…[/bold red]")
        import shutil
        if settings.chroma_persist_dir.exists():
            shutil.rmtree(settings.chroma_persist_dir)
        if settings.papers_json.exists():
            settings.papers_json.unlink()

    # `dbs/output/` is dead as a concept (plan §10.2) — there's nothing
    # there to scan anymore. This tool only ever reads from the legacy
    # drop-folder; ingested bytes live in the ObjectStore from here on.
    all_pdfs = [(p, "toread") for p in sorted(LEGACY_INPUT_DIR.glob("*.pdf"))]
    console.print(f"Found [bold]{len(all_pdfs)}[/bold] PDFs in {LEGACY_INPUT_DIR}")

    if dry_run:
        console.print("[bold yellow]Dry run — no API calls will be made.[/bold yellow]")

    ocr_svc = OCRService()
    embed_svc = EmbeddingService()
    summary_svc = SummaryService()
    vstore = VectorStore(settings.chroma_persist_dir)
    object_store = LocalObjectStore(settings.objects_dir)
    clusterer = HierarchicalClusterer()
    namer = ClusterNamer()

    store = PaperStore()
    store.load()

    if not dry_run:
        console.print("Verifying Ollama connection…")
        await embed_svc.verify()
        console.print("[green]✓ Ollama OK[/green]")

    progress = Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeRemainingColumn(),
        console=console,
    )

    if revector:
        records = store.all()
        console.print(f"Revectoring [bold]{len(records)}[/bold] existing records")
        with progress:
            revector_task = progress.add_task("Revectoring papers", total=len(records))
            BATCH = 5
            for i in range(0, len(records), BATCH):
                batch = records[i : i + BATCH]
                await asyncio.gather(
                    *[
                        revector_one(r, ocr_svc, embed_svc, summary_svc, vstore, store,
                                     object_store, dry_run, progress, revector_task)
                        for r in batch
                    ]
                )

        if dry_run:
            console.print("[bold yellow]Dry run complete. Nothing written.[/bold yellow]")
            return

        await finalize_library(vstore, store, clusterer, namer)
        return

    with progress:
        ingest_task = progress.add_task("Ingesting PDFs", total=len(all_pdfs))
        BATCH = 5
        for i in range(0, len(all_pdfs), BATCH):
            batch = all_pdfs[i : i + BATCH]
            await asyncio.gather(
                *[
                    process_one(p, s, ocr_svc, embed_svc, summary_svc, vstore, store,
                                object_store, dry_run, progress, ingest_task)
                    for p, s in batch
                ]
            )

    if dry_run:
        console.print("[bold yellow]Dry run complete. Nothing written.[/bold yellow]")
        return

    # Save metadata before clustering
    store.save()
    await finalize_library(vstore, store, clusterer, namer)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--revector", action="store_true")
    args = parser.parse_args()
    asyncio.run(main(args.dry_run, args.reset, args.revector))
