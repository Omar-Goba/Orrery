from __future__ import annotations
import asyncio

import numpy as np
from loguru import logger

from backend.config import settings
from backend.services.llm import client_for_role


class EmbeddingService:
    def __init__(self) -> None:
        self._client = client_for_role(settings.llm_embedder)
        self._model = settings.llm_embedder.model
        self._dim: int | None = None

    @property
    def dim(self) -> int | None:
        return self._dim

    async def verify(self) -> int:
        vec = await self.embed_text("warmup")
        self._dim = len(vec)
        return self._dim

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

    def paper_vector(
        self,
        chunk_vectors: list[list[float]],
        *,
        dim: int | None = None,
    ) -> list[float]:
        if not chunk_vectors:
            resolved_dim = dim or self._dim
            if resolved_dim is None:
                raise RuntimeError("Embedding dimension is unknown; call verify() first or pass dim")
            return [0.0] * resolved_dim
        self._dim = len(chunk_vectors[0])
        matrix = np.array(chunk_vectors, dtype=np.float32)
        mean = matrix.mean(axis=0)
        norm = np.linalg.norm(mean)
        if norm > 0:
            mean = mean / norm
        return mean.tolist()
