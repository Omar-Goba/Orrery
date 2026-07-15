export interface Pt {
  id: string;
  x: number;
  y: number;
  leaf: string;
}

export type ConstellationEdge = [string, string];

/** Stable signature for paper-to-leaf membership, independent of response order. */
export function constellationMembershipSignature(pts: readonly Pick<Pt, "id" | "leaf">[]): string {
  return pts
    .map(({ id, leaf }) => `${id.length}:${id}${leaf.length}:${leaf}`)
    .sort()
    .join("|");
}

/** Prim's MST per leaf group. Returns paper-ID pairs safe across node reordering. */
export function buildConstellationEdges(pts: Pt[]): ConstellationEdge[] {
  const byLeaf = new Map<string, number[]>();
  pts.forEach((p, i) => {
    if (p.leaf === "Misc" || p.leaf === "Unclustered") return; // rogues stay untethered
    (byLeaf.get(p.leaf) ?? byLeaf.set(p.leaf, []).get(p.leaf)!).push(i);
  });
  const edges: ConstellationEdge[] = [];
  for (const members of byLeaf.values()) {
    if (members.length < 2) continue;
    const inTree = new Set<number>([members[0]]);
    while (inTree.size < members.length) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const a of inTree) for (const b of members) {
        if (inTree.has(b)) continue;
        const d = (pts[a].x - pts[b].x) ** 2 + (pts[a].y - pts[b].y) ** 2;
        if (d < bestD) { bestD = d; best = [a, b]; }
      }
      edges.push([pts[best![0]].id, pts[best![1]].id]);
      inTree.add(best![1]);
    }
  }
  return edges;
}
