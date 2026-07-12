from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from backend.config import settings
from backend.services.chunking import chunk_text
from backend.services.llm import client_for_role
from backend.services.metadata_extraction import extract_metadata
from loguru import logger

_REFERENCES_RE = re.compile(r"^\s*(references|bibliography)\b", re.IGNORECASE)
_GENERIC_SUMMARY_RE = re.compile(
    r"^\s*(this paper|the paper|this study|the study)\s+"
    r"(discusses|presents|explores|examines|is about|focuses on)\s*\.?\s*$",
    re.IGNORECASE,
)

_SYSTEM_PROMPT = """\
You extract structured metadata from research paper front matter.
Respond with strict JSON only in this exact shape:
{"title": string|null, "author_last": string|null, "year": string|null, "summary": string|null}

Rules:
- author_last is the last name of the first author only.
- year is a four-digit publication year as a string.
- summary is 1-3 concrete sentences about the paper's contribution, not generic boilerplate.
- Use null when unknown."""


@dataclass(frozen=True)
class SummaryResult:
    title: str | None
    author_last: str | None
    year: str | None
    summary: str | None
    source: str


def front_matter_text(text: str, max_chunks: int = 4) -> str:
    chunks = chunk_text(text)[:max_chunks]
    front = "\n\n".join(chunks)
    kept_lines: list[str] = []
    for line in front.splitlines():
        if _REFERENCES_RE.match(line):
            break
        kept_lines.append(line)
    return "\n".join(kept_lines).strip()


class SummaryService:
    async def summarize(self, text: str, filename: str) -> SummaryResult:
        front = front_matter_text(text)
        heuristic = _heuristic_result(front or text, filename)

        result = await self._summarize_llm(front, filename)
        if result:
            return result

        return heuristic

    async def _summarize_llm(self, text: str, filename: str) -> SummaryResult | None:
        try:
            client = client_for_role(settings.llm_summary)
            resp = await client.chat.completions.create(
                model=settings.llm_summary.model,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": _user_prompt(text, filename)},
                ],
                temperature=0,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or "{}"
            return _parse_model_result(content, "llm_summary")
        except Exception:
            logger.exception(
                "LLM call failed role=llm_summary endpoint={} model={}",
                settings.llm_summary.base_url,
                settings.llm_summary.model,
            )
            return None


def _user_prompt(text: str, filename: str) -> str:
    return f"Filename: {filename}\n\nFront matter / early paper text:\n{text[:8000]}"


def _parse_model_result(content: str, source: str) -> SummaryResult | None:
    try:
        raw = json.loads(content)
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, dict):
        return None
    if not all(key in raw for key in ("title", "author_last", "year", "summary")):
        return None

    title = _clean_str(raw.get("title"), max_len=200)
    author_last = _clean_str(raw.get("author_last"), max_len=80)
    year = _clean_year(raw.get("year"))
    summary = _clean_summary(raw.get("summary"))
    if raw.get("summary") is not None and summary is None:
        return None

    return SummaryResult(
        title=title,
        author_last=author_last,
        year=year,
        summary=summary,
        source=source,
    )


def _heuristic_result(text: str, filename: str) -> SummaryResult:
    title, author_last, year = extract_metadata(text, filename)
    return SummaryResult(
        title=title,
        author_last=author_last,
        year=year,
        summary=None,
        source="heuristic",
    )

def _clean_str(value: Any, max_len: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    value = re.sub(r"\s+", " ", value).strip()
    return value[:max_len] if value else None


def _clean_year(value: Any) -> str | None:
    value = _clean_str(value, 20)
    if not value:
        return None
    match = re.search(r"\b(19|20)\d{2}\b", value)
    return match.group(0) if match else None


def _clean_summary(value: Any) -> str | None:
    summary = _clean_str(value, 1000)
    if not summary:
        return None
    if len(summary.split()) < 8:
        return None
    if _GENERIC_SUMMARY_RE.match(summary):
        return None
    return summary
