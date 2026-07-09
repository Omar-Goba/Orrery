from __future__ import annotations
import json
from collections import Counter

from openai import AsyncOpenAI

from backend.config import settings
from backend.models import PaperRecord, Recommendation
from backend.store import paper_store

SYSTEM_PROMPT = """\
You are a research librarian recommending what to read next from a personal paper library.
You are given a list of candidate papers (currently unread) and a summary of the user's \
demonstrated reading interests (based on the folder/cluster paths of papers they've already read).
Pick up to 3 paper_ids from the candidate list that best fit the user's demonstrated interests.
For each pick, write a one-sentence human-readable reason.
Respond with strict JSON only, in this exact shape:
{"picks": [{"paper_id": "...", "reason": "..."}]}"""


class CuratorAgent:
    def __init__(self) -> None:
        self._client = AsyncOpenAI(api_key=settings.openai_api_key)

    async def recommend(self) -> list[Recommendation]:
        all_papers = paper_store.all()
        toread = [p for p in all_papers if p.status == "toread"]
        read = [p for p in all_papers if p.status == "read"]

        if not toread:
            return []

        prompt = self._build_prompt(toread, read)
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]

        resp = await self._client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            temperature=0.4,
            response_format={"type": "json_object"},
        )

        content = resp.choices[0].message.content or "{}"
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return []

        picks = parsed.get("picks", [])
        candidate_ids = {p.id for p in toread}

        recommendations: list[Recommendation] = []
        for pick in picks:
            paper_id = pick.get("paper_id")
            reason = pick.get("reason", "")
            if paper_id not in candidate_ids:
                continue
            record = paper_store.get(paper_id)
            if not record:
                continue
            recommendations.append(Recommendation(
                paper_id=record.id,
                title=record.title or record.filename,
                author=record.author,
                year=record.year,
                cluster_path=record.cluster_path,
                reason=reason,
            ))

        return recommendations

    def _build_prompt(
        self, toread: list[PaperRecord], read: list[PaperRecord]
    ) -> str:
        candidates = "\n".join(
            f"- paper_id={p.id} | title={p.title or p.filename} | "
            f"author={p.author or 'Unknown'} | year={p.year or 'n.d.'} | "
            f"cluster_path={p.cluster_path or 'Unsorted'}"
            for p in toread
        )

        interest_counts = Counter(
            (p.cluster_path or "Unsorted") for p in read
        )
        if interest_counts:
            interests = "\n".join(
                f"- {path}: {count} read paper(s)"
                for path, count in interest_counts.most_common()
            )
        else:
            interests = "(no papers marked as read yet)"

        return (
            f"Candidate papers (unread):\n{candidates}\n\n"
            f"User's demonstrated reading interests (cluster path frequency "
            f"among read papers):\n{interests}"
        )
