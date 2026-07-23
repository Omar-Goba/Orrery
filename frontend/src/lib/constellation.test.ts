import { describe, expect, it } from "vitest";
import {
  buildConstellationEdges,
  constellationMembershipSignature,
  type Pt,
} from "./constellation";

function pt(id: string, x: number, y: number, leaf: string): Pt {
  return { id, x, y, leaf };
}

describe("lib/constellation buildConstellationEdges", () => {
  it("produces members.length - 1 edges per leaf", () => {
    const pts = [
      pt("a", 0, 0, "Diffusion Models"),
      pt("b", 10, 0, "Diffusion Models"),
      pt("c", 20, 0, "Diffusion Models"),
      pt("d", 0, 100, "Diffusion Models"),
    ];
    const edges = buildConstellationEdges(pts);
    expect(edges.length).toBe(pts.length - 1);
  });

  it("produces zero edges for rogue leaves (Misc, Unclustered)", () => {
    const pts = [
      pt("a", 0, 0, "Misc"),
      pt("b", 10, 0, "Misc"),
      pt("c", 0, 0, "Unclustered"),
      pt("d", 10, 0, "Unclustered"),
    ];
    expect(buildConstellationEdges(pts)).toEqual([]);
  });

  it("produces zero edges for a single-member leaf", () => {
    const pts = [pt("a", 0, 0, "Solo Cluster")];
    expect(buildConstellationEdges(pts)).toEqual([]);
  });

  it("is deterministic for identical input", () => {
    const pts = [
      pt("a", 0, 0, "X"),
      pt("b", 5, 5, "X"),
      pt("c", 9, 1, "X"),
    ];
    expect(buildConstellationEdges(pts)).toEqual(buildConstellationEdges(pts));
  });

  it("never connects two different leaves", () => {
    const pts = [
      pt("a", 0, 0, "X"),
      pt("b", 1, 0, "X"),
      pt("c", 100, 100, "Y"),
      pt("d", 101, 100, "Y"),
    ];
    const edges = buildConstellationEdges(pts);
    const byId = new Map(pts.map(point => [point.id, point]));
    for (const [aId, bId] of edges) {
      expect(byId.get(aId)?.leaf).toBe(byId.get(bId)?.leaf);
    }
  });

  it("returns stable paper IDs rather than response indexes", () => {
    const pts = [pt("paper-a", 0, 0, "X"), pt("paper-b", 2, 0, "X")];
    expect(buildConstellationEdges(pts)).toEqual([["paper-a", "paper-b"]]);
  });

  it("detects leaf-only reindex changes but ignores response reordering", () => {
    const before = [pt("a", 0, 0, "X"), pt("b", 1, 0, "X")];
    const reordered = [before[1], before[0]];
    const reindexed = [before[0], pt("b", 1, 0, "Y")];

    expect(constellationMembershipSignature(reordered)).toBe(constellationMembershipSignature(before));
    expect(constellationMembershipSignature(reindexed)).not.toBe(constellationMembershipSignature(before));
  });
});
