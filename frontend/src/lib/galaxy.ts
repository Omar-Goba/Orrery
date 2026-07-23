import type { PaperRecord, PublicGalaxy } from "../api/client";

export const MAX_PUBLIC_GALAXIES = 12;

export interface GalaxyPosition extends PublicGalaxy {
  x: number;
  y: number;
}

export function positionGalaxies(galaxies: PublicGalaxy[]): GalaxyPosition[] {
  const visible = galaxies.slice(0, MAX_PUBLIC_GALAXIES);
  return visible.map((galaxy, index) => {
    const ring = index % 2;
    const angle = (index / Math.max(visible.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radiusX = ring ? 530 : 360;
    const radiusY = ring ? 330 : 235;
    return {
      ...galaxy,
      x: Math.cos(angle) * radiusX,
      y: Math.sin(angle) * radiusY,
    };
  });
}

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
