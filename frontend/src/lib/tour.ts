import type { PaperRecord } from "../api/client";

export interface TourStop {
  path: string;
  label: string;
  count: number;
}

export function buildTourStops(papers: PaperRecord[], max = 5): TourStop[] {
  const counts = new Map<string, number>();
  for (const p of papers) {
    const l1 = p.cluster_path?.split("/")[0];
    if (l1 && l1 !== "Misc") counts.set(l1, (counts.get(l1) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([path, count]) => ({ path, label: path, count }));
}
