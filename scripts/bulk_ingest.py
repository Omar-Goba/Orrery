#!/usr/bin/env python3
"""Bootstrap all existing PDFs into the library.

Usage:
    python scripts/bulk_ingest.py          # full run
    python scripts/bulk_ingest.py --dry-run  # preview only
    python scripts/bulk_ingest.py --reset    # clear Chroma + papers.json and start fresh
"""
from __future__ import annotations
import argparse
import asyncio
import json
import os
import re
import sys
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
from backend.services.filesystem import FilesystemService
from backend.services.ocr import OCRService
from backend.services.vectorstore import VectorStore
from backend.store import PaperStore, paper_id_for

console = Console()
MAX_CHARS = 2000
OVERLAP_CHARS = 150


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


async def process_one(
    pdf_path: Path,
    status: str,
    ocr_svc: OCRService,
    embed_svc: EmbeddingService,
    vstore: VectorStore,
    store: PaperStore,
    dry_run: bool,
    progress: Progress,
    task_id,
) -> PaperRecord | None:
    paper_id = paper_id_for(pdf_path)

    if vstore.paper_exists(paper_id):
        progress.advance(task_id)
        progress.log(f"[dim]skip (already ingested):[/dim] {pdf_path.name}")
        return store.get(paper_id)

    if dry_run:
        progress.advance(task_id)
        progress.log(f"[cyan]would ingest:[/cyan] {pdf_path.name} [{status}]")
        return None

    try:
        text = await ocr_svc.extract(pdf_path)
        if not text.strip():
            progress.log(f"[yellow]warn: empty OCR for {pdf_path.name}[/yellow]")
            text = pdf_path.stem.replace("_", " ")

        title, author, year = extract_metadata(text, pdf_path.stem)
        chunks = chunk_text(text)
        chunk_vecs = await embed_svc.embed_batch(chunks)
        paper_vec = embed_svc.paper_vector(chunk_vecs)

        chunk_records = [
            ChunkRecord(paper_id=paper_id, chunk_index=i, text=c, token_count=len(c) // 4)
            for i, c in enumerate(chunks)
        ]
        vstore.add_chunks(paper_id, chunk_records, chunk_vecs)
        vstore.upsert_paper_vector(
            paper_id, paper_vec,
            {"filename": pdf_path.name, "status": status,
             "original_path": str(pdf_path.resolve()),
             "title": title or "", "author": author or "", "year": year or ""},
        )

        record = PaperRecord(
            id=paper_id, filename=pdf_path.name,
            original_path=str(pdf_path.resolve()),
            status=status,  # type: ignore[arg-type]
            title=title, author=author, year=year, ocr_cached=True,
            ingested_at=datetime.now(timezone.utc),
        )
        store.put(record)
        progress.advance(task_id)
        return record

    except Exception as exc:
        progress.log(f"[red]ERROR {pdf_path.name}:[/red] {exc}")
        err_file = ROOT / "bulk_ingest_errors.jsonl"
        with open(err_file, "a") as f:
            f.write(json.dumps({"file": str(pdf_path), "error": str(exc)}) + "\n")
        progress.advance(task_id)
        return None


async def main(dry_run: bool, reset: bool) -> None:
    if reset and not dry_run:
        console.print("[bold red]Resetting Chroma and papers.json…[/bold red]")
        import shutil
        if settings.chroma_persist_dir.exists():
            shutil.rmtree(settings.chroma_persist_dir)
        if settings.papers_json.exists():
            settings.papers_json.unlink()

    input_pdfs = [(p, "toread") for p in sorted(settings.input_dir.glob("*.pdf"))]
    output_pdfs = [(p, "read") for p in sorted(settings.output_dir.rglob("*.pdf"))
                   if not p.is_symlink()]
    all_pdfs = input_pdfs + output_pdfs
    console.print(f"Found [bold]{len(all_pdfs)}[/bold] PDFs "
                  f"({len(input_pdfs)} to-read, {len(output_pdfs)} read)")

    if dry_run:
        console.print("[bold yellow]Dry run — no API calls will be made.[/bold yellow]")

    ocr_svc = OCRService()
    embed_svc = EmbeddingService()
    vstore = VectorStore(settings.chroma_persist_dir)
    clusterer = HierarchicalClusterer()
    namer = ClusterNamer()
    fs_svc = FilesystemService()

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

    with progress:
        ingest_task = progress.add_task("Ingesting PDFs", total=len(all_pdfs))
        BATCH = 5
        for i in range(0, len(all_pdfs), BATCH):
            batch = all_pdfs[i : i + BATCH]
            results = await asyncio.gather(
                *[
                    process_one(p, s, ocr_svc, embed_svc, vstore, store,
                                dry_run, progress, ingest_task)
                    for p, s in batch
                ]
            )

    if dry_run:
        console.print("[bold yellow]Dry run complete. Nothing written.[/bold yellow]")
        return

    # Save metadata before clustering
    store.save()

    # Clustering
    console.print("\nClustering papers…")
    paper_ids, vectors = vstore.get_all_paper_vectors()
    if not paper_ids:
        console.print("[yellow]No papers in vector store — skipping clustering.[/yellow]")
        return

    tree = clusterer.cluster(paper_ids, vectors)
    console.print(f"Found [bold]{len(tree)}[/bold] top-level clusters")

    # Name clusters — bottom-up so internal nodes are named after their children
    console.print("Naming clusters with Gemma…")
    with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as p2:
        name_task = p2.add_task("Naming…", total=None)

        async def name_node(node) -> None:
            if node.is_leaf:
                titles = []
                for pid in node.paper_ids:
                    r = store.get(pid)
                    if r:
                        titles.append(r.title or r.filename)
                node.name = await namer.name_cluster(titles)
            else:
                for child in node.children:
                    await name_node(child)
                node.name = await namer.name_cluster(
                    [c.name for c in node.children if c.name]
                )
            p2.advance(name_task)

        for top_node in tree:
            await name_node(top_node)

    # Assign cluster paths to records
    def assign_paths(nodes: list, prefix: str = "") -> None:
        for node in nodes:
            path = f"{prefix}/{node.name}" if prefix else node.name
            if node.is_leaf:
                for pid in node.paper_ids:
                    r = store.get(pid)
                    if r:
                        r.cluster_path = path
                        r.symlink_name = fs_svc.make_symlink_name(r)
            else:
                assign_paths(node.children, path)

    assign_paths(tree)

    # Rebuild filesystem
    console.print("Rebuilding output tree…")
    fs_svc.rebuild_tree(tree, store.as_dict())
    store.save()

    console.print(f"\n[bold green]Done![/bold green] {len(store)} papers in library.")
    console.print(f"Output tree: {settings.output_dir}")

    # Print tree summary (recursive, handles any depth)
    def print_tree(nodes: list, indent: int = 0) -> None:
        prefix = "  " * indent
        for node in nodes:
            if node.is_leaf:
                console.print(f"{prefix}[dim]({len(node.paper_ids)} papers)[/dim]")
            else:
                console.print(f"{prefix}[bold]{node.name}[/bold]/")
                print_tree(node.children, indent + 1)

    print_tree(tree)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()
    asyncio.run(main(args.dry_run, args.reset))
