import { describe, expect, it } from "vitest";
import { buildConstellationEdges, type Pt } from "./constellation";

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
    for (const [ai, bi] of edges) {
      expect(pts[ai].leaf).toBe(pts[bi].leaf);
    }
  });
});
