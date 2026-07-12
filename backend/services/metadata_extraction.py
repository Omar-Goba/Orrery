from __future__ import annotations

import re
from pathlib import Path

_SKIP_TITLE = re.compile(
    r"https?://|see discussions|researchgate\.net|arxiv\.org|doi\.org|"
    r"all rights reserved|\u00a9\s*\d{4}|open access|preprint|under review|"
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

    lines = [line.strip() for line in text[:5000].splitlines() if line.strip()]
    title_idx = None
    title = None
    for i, line in enumerate(lines[:25]):
        if len(line) < 8 or len(line) > 200:
            continue
        if len(line.split()) < 3:  # single journal names / acronyms
            continue
        if _SKIP_TITLE.search(line):
            continue
        if re.search(r"\d+:\d+", line):  # journal vol:page
            continue
        title = re.sub(r"\b([A-Z])\s+([A-Z]{2,})", r"\1\2", line)[:150]
        title_idx = i
        break
    if not title:
        title = Path(filename).stem.replace("_", " ").replace("-", " ")

    # If title ends with a preposition it's likely split across PDF lines.
    if title and title_idx is not None and re.search(
        r"(?:\b(for|in|of|with|the|an?|and|or|by|to|on|at|as|via|from)|:)\s*$",
        title,
        re.IGNORECASE,
    ):
        for j in range(title_idx + 1, min(title_idx + 3, len(lines))):
            ext = lines[j]
            if ext and not _SKIP_TITLE.search(ext) and not re.search(r"\d+:\d+", ext):
                title = (title.rstrip() + " " + ext)[:150]
                break

    start = (title_idx + 1) if title_idx is not None else 1
    author_last = None
    for match in re.finditer(
        r"\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b",
        "\n".join(lines[start : start + 10]),
    ):
        if match.group(1) not in _FALSE_AUTHOR:
            author_last = match.group(1)
            break

    return title, author_last, year
