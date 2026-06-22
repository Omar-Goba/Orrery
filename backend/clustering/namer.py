from __future__ import annotations
import re

import httpx

from backend.config import settings

_PROMPT_TEMPLATE = """\
You are a file system organizer. Given a list of research paper titles, \
generate a concise folder name in Title Case (2-4 words, no numbers, no explanation, no punctuation).

Papers:
{titles}

Folder name (Title Case words only, nothing else):"""


class ClusterNamer:
    def __init__(self) -> None:
        self._base = settings.ollama_base_url
        self._model = settings.ollama_namer_model

    async def name_cluster(self, paper_summaries: list[str]) -> str:
        if not paper_summaries:
            return "misc_papers"
        titles = "\n".join(f"- {s[:120]}" for s in paper_summaries[:12])
        prompt = _PROMPT_TEMPLATE.format(titles=titles)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self._base}/api/generate",
                    json={"model": self._model, "prompt": prompt, "stream": False},
                )
                resp.raise_for_status()
                raw = resp.json().get("response", "")
                return self._sanitize(raw)
        except Exception:
            return self._sanitize(paper_summaries[0])

    def _sanitize(self, raw: str) -> str:
        line = raw.strip().splitlines()[0].strip()
        # Strip punctuation/special chars but keep letters, digits, spaces
        line = re.sub(r"[^\w\s]", "", line)
        # Collapse whitespace
        line = re.sub(r"\s+", " ", line).strip()
        # Title-case each word
        line = " ".join(w.capitalize() for w in line.split())
        return line[:60] or "Cluster"
