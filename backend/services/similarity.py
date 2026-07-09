"""Pure numpy helper for embedding-space nearest-neighbor computation."""
from __future__ import annotations

import numpy as np


def top_k_neighbors(
    ids: list[str], vectors: list[list[float]], k: int = 6
) -> dict[str, list[dict]]:
    """Compute top-k cosine-similarity neighbors for every id, in-memory.

    Returns {paper_id: [{"id": other_id, "score": float}, ...]} sorted by
    descending score, excluding self-matches. Papers with fewer than 2 total
    vectors naturally get an empty neighbor list.
    """
    if len(ids) < 2:
        return {pid: [] for pid in ids}

    mat = np.asarray(vectors, dtype=np.float64)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1e-12
    unit = mat / norms
    sims = unit @ unit.T
    np.clip(sims, 0.0, 1.0, out=sims)

    result: dict[str, list[dict]] = {}
    n = len(ids)
    kk = min(k, n - 1)
    for i, pid in enumerate(ids):
        row = sims[i].copy()
        row[i] = -np.inf  # exclude self-match
        top_idx = np.argsort(row)[::-1][:kk]
        result[pid] = [
            {"id": ids[j], "score": float(sims[i, j])} for j in top_idx
        ]
    return result
