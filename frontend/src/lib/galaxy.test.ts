import { describe, expect, it } from "vitest";
import type { PaperRecord } from "../api/client";
import { computeGalaxyStats, cometStrength } from "./galaxy";

function makePaper(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    id: "p1",
    filename: "paper.pdf",
    source_filename: "paper.pdf",
    status: "toread",
    title: "A Paper",
    author: "Someone",
    year: "2024",
    summary: null,
    cluster_path: "Diffusion Models/Score Matching",
    ingested_at: null,
    ocr_cached: false,
    ...overrides,
  };
}

describe("lib/galaxy computeGalaxyStats", () => {
  it("counts stars, ignited, and constellations", () => {
    const papers = [
      makePaper({ id: "a", status: "read", cluster_path: "X/Leaf1" }),
      makePaper({ id: "b", status: "toread", cluster_path: "X/Leaf1" }),
      makePaper({ id: "c", status: "read", cluster_path: "X/Leaf2" }),
    ];
    const stats = computeGalaxyStats(papers);
    expect(stats.stars).toBe(3);
    expect(stats.ignited).toBe(2);
    expect(stats.constellations).toBe(2);
  });

  it("latestCometAt picks the max ingested_at", () => {
    const papers = [
      makePaper({ id: "a", ingested_at: "2024-01-01T00:00:00Z" }),
      makePaper({ id: "b", ingested_at: "2024-06-01T00:00:00Z" }),
      makePaper({ id: "c", ingested_at: "2024-03-01T00:00:00Z" }),
    ];
    expect(computeGalaxyStats(papers).latestCometAt).toBe("2024-06-01T00:00:00Z");
  });

  it("empty list gives zeros and a null latestCometAt", () => {
    const stats = computeGalaxyStats([]);
    expect(stats).toEqual({ stars: 0, ignited: 0, constellations: 0, latestCometAt: null });
  });
});

describe("lib/galaxy cometStrength", () => {
  const now = Date.parse("2024-06-08T00:00:00Z");

  it("is ~1 for a fresh timestamp", () => {
    expect(cometStrength(new Date(now).toISOString(), now)).toBeCloseTo(1, 5);
  });

  it("is ~0.5 at 3.5 days old", () => {
    const ts = new Date(now - 3.5 * 86_400_000).toISOString();
    expect(cometStrength(ts, now)).toBeCloseTo(0.5, 5);
  });

  it("is 0 past 7 days old", () => {
    const ts = new Date(now - 8 * 86_400_000).toISOString();
    expect(cometStrength(ts, now)).toBe(0);
  });

  it("is 0 for null", () => {
    expect(cometStrength(null, now)).toBe(0);
  });

  it("is 0 for a garbage timestamp", () => {
    expect(cometStrength("not-a-date", now)).toBe(0);
  });

  it("is 0 for a future timestamp", () => {
    const ts = new Date(now + 86_400_000).toISOString();
    expect(cometStrength(ts, now)).toBe(0);
  });
});
