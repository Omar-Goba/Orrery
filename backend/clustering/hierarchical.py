from __future__ import annotations
from dataclasses import dataclass, field

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import pdist


@dataclass
class ClusterNode:
    name: str = ""
    paper_ids: list[str] = field(default_factory=list)    # non-empty iff leaf
    children: list["ClusterNode"] = field(default_factory=list)

    @property
    def is_leaf(self) -> bool:
        return len(self.children) == 0

    def all_paper_ids(self) -> list[str]:
        if self.is_leaf:
            return list(self.paper_ids)
        out: list[str] = []
        for child in self.children:
            out.extend(child.all_paper_ids())
        return out


ClusterTree = list[ClusterNode]


class HierarchicalClusterer:
    # ── tuneable parameters ────────────────────────────────────────────────
    MIN_LEAF_SIZE      = 3     # fewest papers allowed in a leaf; below this → don't split
    MAX_DEPTH          = 6     # hard recursion cap
    COHESION_THRESHOLD = 0.20  # avg cosine dist below this → cluster is semantically pure
    BRANCH_MIN         = 2     # fewest children at any internal node
    BRANCH_MAX         = 7     # most children at any internal node

    # ── public API ─────────────────────────────────────────────────────────

    def cluster(
        self,
        paper_ids: list[str],
        vectors: list[list[float]],
    ) -> ClusterTree:
        if not paper_ids:
            return []

        root = self._cluster(paper_ids, vectors, depth=0)

        # If everything ended up in one leaf (too few/cohesive papers), return
        # it as a single top-level cluster.
        if root.is_leaf:
            return [root]
        return root.children

    # ── core recursive algorithm ───────────────────────────────────────────

    def _cluster(
        self,
        paper_ids: list[str],
        vectors: list[list[float]],
        depth: int,
    ) -> ClusterNode:
        n = len(paper_ids)

        # ── Leaf conditions ────────────────────────────────────────────────
        if n <= self.MIN_LEAF_SIZE or depth >= self.MAX_DEPTH:
            return ClusterNode(paper_ids=list(paper_ids))

        matrix = np.array(vectors, dtype=np.float64)
        dist   = np.clip(pdist(matrix, metric="cosine"), 0, None)

        # Cohesion: cluster is already semantically tight → no meaningful split
        if dist.mean() < self.COHESION_THRESHOLD:
            return ClusterNode(paper_ids=list(paper_ids))

        # ── Linkage + adaptive k ───────────────────────────────────────────
        Z = linkage(dist, method="ward")
        k = self._choose_k(Z, n)

        # Balance enforcement: reduce k if any child would be below MIN_LEAF_SIZE
        while k > self.BRANCH_MIN:
            labels = fcluster(Z, k, criterion="maxclust")
            if min(np.bincount(labels)[1:]) >= self.MIN_LEAF_SIZE:
                break
            k -= 1
        labels = fcluster(Z, k, criterion="maxclust")

        # If even at BRANCH_MIN the split is degenerate (e.g. 1 vs n-1),
        # keep this node as a leaf rather than create satellite 1-paper clusters.
        if min(np.bincount(labels)[1:]) < self.MIN_LEAF_SIZE:
            return ClusterNode(paper_ids=list(paper_ids))

        # ── Recurse into each child ────────────────────────────────────────
        children: list[ClusterNode] = []
        for cid in sorted(set(labels)):
            idxs = [i for i, lbl in enumerate(labels) if lbl == cid]
            child = self._cluster(
                [paper_ids[i] for i in idxs],
                [vectors[i]   for i in idxs],
                depth + 1,
            )
            children.append(child)

        return ClusterNode(children=children)

    # ── k-selection via largest dendrogram height gap ──────────────────────

    def _choose_k(self, Z: np.ndarray, n: int) -> int:
        """
        Read the dendrogram's own structure to pick k.

        Ward stores merge heights in Z[:, 2] sorted ascending.  The last
        (BRANCH_MAX - 1) diffs cover the range k=2 … k=BRANCH_MAX.  The
        biggest jump in that window marks the "sharpest" natural partition.

          tail index  → corresponds to k
          tail[0]     → BRANCH_MAX clusters
          tail[look-1]→ 2 clusters
          formula: k = look - gap_pos + 1
        """
        heights  = Z[:, 2]
        diffs    = np.diff(heights)
        look     = min(self.BRANCH_MAX - 1, len(diffs))
        if look == 0:
            return self.BRANCH_MIN

        tail     = diffs[-look:]
        gap_pos  = int(np.argmax(tail))
        k        = look - gap_pos + 1

        max_k = n // self.MIN_LEAF_SIZE
        return max(self.BRANCH_MIN, min(k, self.BRANCH_MAX, max_k))
