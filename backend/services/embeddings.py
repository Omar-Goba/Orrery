from __future__ import annotations
import asyncio

import numpy as np
from loguru import logger

from backend.config import settings
from backend.services.llm import client_for_role

EXPECTED_DIM = 1024


class EmbeddingService:
    def __init__(self) -> None:
        self._client = client_for_role(settings.llm_embedder)
        self._model = settings.llm_embedder.model

    async def verify(self) -> None:
        vec = await self.embed_text("warmup")
        if len(vec) != EXPECTED_DIM:
            raise RuntimeError(
                f"Expected {EXPECTED_DIM}-dim embeddings from {self._model}, got {len(vec)}"
            )

    async def embed_text(self, text: str) -> list[float]:
        # Progressively truncate if the model rejects the input length
        for limit in [len(text), 1800, 1200, 800, 400]:
            try:
                resp = await self._client.embeddings.create(
                    model=self._model,
                    input=text[:limit],
                )
                return resp.data[0].embedding
            except Exception as e:
                if limit == 400:
                    logger.exception(
                        "LLM call failed role=llm_embedder endpoint={} model={}",
                        settings.llm_embedder.base_url,
                        settings.llm_embedder.model,
                    )
                    raise
                if "context length" not in str(e).lower() and "input length" not in str(e).lower():
                    logger.exception(
                        "LLM call failed role=llm_embedder endpoint={} model={}",
                        settings.llm_embedder.base_url,
                        settings.llm_embedder.model,
                    )
                    raise
        raise RuntimeError("embed_text: all truncation levels failed")

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        results: list[list[float]] = []
        for text in texts:
            results.append(await self.embed_text(text))
            await asyncio.sleep(0)  # yield to event loop
        return results

    def paper_vector(self, chunk_vectors: list[list[float]]) -> list[float]:
        if not chunk_vectors:
            return [0.0] * EXPECTED_DIM
        matrix = np.array(chunk_vectors, dtype=np.float32)
        mean = matrix.mean(axis=0)
        norm = np.linalg.norm(mean)
        if norm > 0:
            mean = mean / norm
        return mean.tolist()
