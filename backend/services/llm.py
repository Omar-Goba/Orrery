from __future__ import annotations

from functools import lru_cache

from openai import AsyncOpenAI

from backend.config import RoleConfig


@lru_cache(maxsize=None)
def _client_for(base_url: str, api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=base_url, api_key=api_key or "ollama")


def client_for_role(role: RoleConfig) -> AsyncOpenAI:
    return _client_for(role.base_url, role.api_key)
