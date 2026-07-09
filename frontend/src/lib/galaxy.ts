import type { PaperRecord } from "../api/client";

export interface GalaxyGlyph {
  username: string;
  displayName: string;   // "Omar's galaxy"
  stars: number;
  ignited: number;
  constellations: number;
  isOpen: boolean;       // open to visitors
  isFake: boolean;
}

export const FAKE_GALAXIES: GalaxyGlyph[] = [
  { username: "m.chen",  displayName: "m. chen's galaxy", stars: 34, ignited: 12,
    constellations: 5, isOpen: false, isFake: true },
  { username: "vega-7",  displayName: "vega-7's galaxy",  stars: 61, ignited: 40,
    constellations: 8, isOpen: false, isFake: true },
];

export function computeGalaxyStats(papers: PaperRecord[]): {
  stars: number; ignited: number; constellations: number; latestCometAt: string | null;
} {
  const leafPaths = new Set(papers.map(p => p.cluster_path ?? "Unclustered"));
  const ingested = papers.map(p => p.ingested_at).filter(Boolean).sort() as string[];
  return {
    stars: papers.length,
    ignited: papers.filter(p => p.status === "read").length,
    constellations: leafPaths.size,
    latestCometAt: ingested.at(-1) ?? null,
  };
}

/** 1 = ingested right now, fading linearly to 0 at 7 days old. 0 outside that window. */
export function cometStrength(ingestedAt: string | null, now = Date.now()): number {
  if (!ingestedAt) return 0;
  const parsed = Date.parse(ingestedAt);
  if (Number.isNaN(parsed)) return 0;
  const days = (now - parsed) / 86_400_000;
  if (days < 0 || days > 7) return 0;
  return 1 - days / 7;
}
