from __future__ import annotations
import re
from typing import AsyncGenerator

from loguru import logger

from backend.config import settings
from backend.models import Citation, PaperRecord
from backend.services.embeddings import EmbeddingService
from backend.services.llm import client_for_role
from backend.services.retrieval_defaults import ORACLE_CONTEXT_K
from backend.services.sse import sse
from backend.services.vectorstore import VectorStore
from backend.store import PaperStore

SYSTEM_PROMPT = """\
You are a research assistant with access to a curated personal paper library.
Answer questions using ONLY information from the retrieved paper excerpts below.
After each factual claim, add an inline citation in the format [Author, Year].
If a paper has no author use the first word of its title.
If the answer is not in the excerpts, say so honestly — do not hallucinate."""


class OracleAgent:
    def __init__(
        self,
        embed_svc: EmbeddingService,
        vstore: VectorStore,
        paper_store: PaperStore,
    ) -> None:
        self._client = client_for_role(settings.llm_oracle)
        self._model = settings.llm_oracle.model
        self._embed = embed_svc
        self._vstore = vstore
        self._papers = paper_store

    async def stream(self, question: str) -> AsyncGenerator[str, None]:
        q_vec = await self._embed.embed_text(question)
        chunks = self._vstore.query_chunks(q_vec, n_results=ORACLE_CONTEXT_K)

        context = self._build_context(chunks)
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"},
        ]

        full_response = ""
        try:
            async with self._client.chat.completions.stream(
                model=self._model,
                messages=messages,
                temperature=0.3,
            ) as stream:
                async for event in stream:
                    if event.type == "content.delta":
                        full_response += event.delta
                        yield sse({"type": "chunk", "text": event.delta})
        except Exception:
            logger.exception(
                "LLM call failed role=llm_oracle endpoint={} model={}",
                settings.llm_oracle.base_url,
                settings.llm_oracle.model,
            )
            raise

        citations = self._extract_citations(full_response, chunks)
        if citations:
            yield sse({
                "type": "citations",
                "papers": [c.model_dump() for c in citations],
            })

        yield sse({"type": "done"})

    def _build_context(self, chunks: list[dict]) -> str:
        parts: list[str] = []
        for i, c in enumerate(chunks, 1):
            pid = c["paper_id"]
            record: PaperRecord | None = self._papers.get(pid)
            author = (record.author or "Unknown") if record else "Unknown"
            year = (record.year or "n.d.") if record else "n.d."
            title = (record.title or pid) if record else pid
            parts.append(f"[{i}] {author}, {year} — {title}\n{c['text']}")
        return "\n\n---\n\n".join(parts)

    def _extract_citations(
        self, text: str, chunks: list[dict]
    ) -> list[Citation]:
        cited: list[Citation] = []
        seen: set[str] = set()
        pid_set = {c["paper_id"] for c in chunks}

        for pid in pid_set:
            record = self._papers.get(pid)
            if not record or pid in seen:
                continue
            author = record.author or "Unknown"
            year = record.year or "n.d."
            pattern = re.compile(
                rf"\[{re.escape(author)},?\s*{re.escape(year)}\]", re.IGNORECASE
            )
            if pattern.search(text):
                cited.append(Citation(
                    paper_id=pid,
                    author=author,
                    year=year,
                    title=record.title or record.filename,
                    cluster_path=record.cluster_path,
                ))
                seen.add(pid)

        return cited
