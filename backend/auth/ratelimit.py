"""Tiny in-house rate limiter — a fixed-window counter per (bucket, key).

No new dependency; per the plan's own estimate this is ~30 lines. Not
distributed-safe (in-process dict), which is fine for a single-node deploy.
"""
from __future__ import annotations

import time
from collections import defaultdict


class RateLimiter:
    def __init__(self, max_calls: int, window_seconds: float) -> None:
        self.max_calls = max_calls
        self.window_seconds = window_seconds
        self._hits: dict[str, list[float]] = defaultdict(list)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        window_start = now - self.window_seconds
        hits = self._hits[key]
        # drop expired hits
        while hits and hits[0] < window_start:
            hits.pop(0)
        if len(hits) >= self.max_calls:
            return False
        hits.append(now)
        return True

    def reset(self) -> None:
        self._hits.clear()


# Rate limits from plan §3.3.
login_limiter = RateLimiter(max_calls=5, window_seconds=60)
signup_limiter = RateLimiter(max_calls=3, window_seconds=60 * 60)

# Public tour chat spends LLM tokens, so keep it much tighter than read-only
# tour browsing. Plan §7: 10 messages/hour/IP.
tour_chat_limiter = RateLimiter(max_calls=10, window_seconds=60 * 60)
client_log_limiter = RateLimiter(max_calls=10, window_seconds=60 * 60)
