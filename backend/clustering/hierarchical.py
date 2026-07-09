from __future__ import annotations
from dataclasses import dataclass, field

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import pdist
from sklearn.metrics import silhouette_score


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
    MAX_LEAF_SIZE      = 14    # above this, force the best valid split
    MAX_DEPTH          = 6     # hard recursion cap
    MIN_SILHOUETTE     = 0.08  # split only when the best candidate is meaningful
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
        vectors_by_id = dict(zip(paper_ids, vectors))
        extracted = self._extract_outliers(root, vectors_by_id)

        # If everything ended up in one leaf, return
        # it as a single top-level cluster.
        if root.is_leaf:
            clusters = [root]
        else:
            clusters = root.children

        if extracted:
            clusters.append(ClusterNode(name="Misc", paper_ids=extracted))
        return clusters

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

        matrix = self._normalized_matrix(vectors)
        dist = pdist(matrix, metric="euclidean")

        # ── Linkage + adaptive k ───────────────────────────────────────────
        Z = linkage(dist, method="ward")
        candidate = self._best_split(Z, matrix, n)

        if candidate is None:
            return ClusterNode(paper_ids=list(paper_ids))

        labels, score = candidate
        if score < self.MIN_SILHOUETTE and n <= self.MAX_LEAF_SIZE:
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

    # ── split selection + cleanup ──────────────────────────────────────────

    def _normalized_matrix(self, vectors: list[list[float]]) -> np.ndarray:
        matrix = np.array(vectors, dtype=np.float64)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        return np.divide(matrix, norms, out=np.zeros_like(matrix), where=norms > 0)

    def _best_split(
        self,
        Z: np.ndarray,
        matrix: np.ndarray,
        n: int,
    ) -> tuple[np.ndarray, float] | None:
        max_k = min(self.BRANCH_MAX, n // self.MIN_LEAF_SIZE)
        best_labels: np.ndarray | None = None
        best_score = float("-inf")

        for k in range(self.BRANCH_MIN, max_k + 1):
            labels = fcluster(Z, k, criterion="maxclust")
            counts = np.bincount(labels)[1:]
            if len(counts) < self.BRANCH_MIN or counts.min() < self.MIN_LEAF_SIZE:
                continue

            score = float(silhouette_score(matrix, labels, metric="cosine"))
            if score > best_score:
                best_labels = labels
                best_score = score

        if best_labels is None:
            return None
        return best_labels, best_score

    def _extract_outliers(
        self,
        node: ClusterNode,
        vectors_by_id: dict[str, list[float]],
    ) -> list[str]:
        if not node.is_leaf:
            extracted: list[str] = []
            for child in node.children:
                extracted.extend(self._extract_outliers(child, vectors_by_id))
            return extracted

        if len(node.paper_ids) < self.MIN_LEAF_SIZE + 1:
            return []

        matrix = self._normalized_matrix(
            [vectors_by_id[paper_id] for paper_id in node.paper_ids]
        )
        centroid = matrix.mean(axis=0)
        centroid_norm = np.linalg.norm(centroid)
        if centroid_norm == 0:
            return []

        sims = matrix @ (centroid / centroid_norm)
        threshold = float(sims.mean() - 2 * sims.std())
        outlier_idxs = [
            i for i, sim in enumerate(sims)
            if sim < threshold and sim < 0.55
        ]
        remaining = len(node.paper_ids) - len(outlier_idxs)
        if not outlier_idxs or remaining < self.MIN_LEAF_SIZE:
            return []

        outlier_set = set(outlier_idxs)
        extracted = [
            paper_id for i, paper_id in enumerate(node.paper_ids)
            if i in outlier_set
        ]
        node.paper_ids = [
            paper_id for i, paper_id in enumerate(node.paper_ids)
            if i not in outlier_set
        ]
        return extracted
