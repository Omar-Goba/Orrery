import { describe, expect, it, vi } from "vitest";
import {
  INGEST_CANCEL_FADE_MS,
  createIngestOrbState,
  ingestOrbOpacity,
  resolveIngestOrb,
  shouldRemoveIngestOrb,
  stepIngestOrb,
  suppressedPaperId,
  updateIngestOrb,
  cancelIngestOrb,
} from "./ingestOrbController";

const bounds = { minX: 40, maxX: 760, minY: 50, maxY: 550 };
const anchors = [
  { path: "Alpha", x: 200, y: 180 },
  { path: "Beta", x: 600, y: 400 },
];

function frame(now: number, overrides = {}) {
  return {
    now,
    dt: 0.016,
    bounds,
    anchors,
    pointer: null,
    finalTarget: null,
    reducedMotion: false,
    ...overrides,
  };
}

describe("ingest orb controller", () => {
  it("explores deterministically, stays bounded, and holds at 100%", () => {
    const first = createIngestOrbState(1, "paper.pdf:42", 0, bounds, false);
    const second = createIngestOrbState(2, "paper.pdf:42", 0, bounds, false);
    for (const pct of [35, 55, 75, 95, 100]) {
      updateIngestOrb(first, { step: "Working", pct });
      updateIngestOrb(second, { step: "Working", pct });
      stepIngestOrb(first, frame(pct * 20, { pointer: { x: first.position.x, y: first.position.y } }));
      stepIngestOrb(second, frame(pct * 20, { pointer: { x: second.position.x, y: second.position.y } }));
    }
    expect(first.lastTargetPath).toBe(second.lastTargetPath);
    expect(first.motion.phase).toBe("holding");
    expect(first.position.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(first.position.x).toBeLessThanOrEqual(bounds.maxX);
  });

  it("deflects gently from the cursor without changing its exploration target", () => {
    const untouched = createIngestOrbState(1, "cursor", 0, bounds, false);
    const repelled = createIngestOrbState(2, "cursor", 0, bounds, false);
    updateIngestOrb(untouched, { step: "Survey", pct: 45 });
    updateIngestOrb(repelled, { step: "Survey", pct: 45 });
    stepIngestOrb(untouched, frame(100));
    const onVerticalEdge = repelled.position.x === bounds.minX || repelled.position.x === bounds.maxX;
    const pointer = onVerticalEdge
      ? { x: repelled.position.x, y: repelled.position.y + 1 }
      : { x: repelled.position.x + 1, y: repelled.position.y };
    stepIngestOrb(repelled, frame(100, { pointer }));
    expect(repelled.lastTargetPath).toBe(untouched.lastTargetPath);
    expect(repelled.position).not.toEqual(untouched.position);
    expect(repelled.position.x).toBeGreaterThanOrEqual(bounds.minX);
  });

  it.each([
    ["an existing cluster", "Alpha/Leaf"],
    ["Unclustered", null],
  ])("acquires %s only by final paper ID", (_label, clusterPath) => {
    const orb = createIngestOrbState(1, "known", 0, bounds, false);
    resolveIngestOrb(orb, { id: "known-paper", cluster_path: clusterPath }, 100);
    stepIngestOrb(orb, frame(100, { finalTarget: { x: 250, y: 210 } }));
    expect(suppressedPaperId(orb)).toBe("known-paper");
    expect(orb.finalClusterPath).toBe(clusterPath);
  });

  it("waits for a delayed new-cluster node and morphs to its live position", () => {
    vi.useFakeTimers();
    const orb = createIngestOrbState(1, "seed", 0, bounds, false);
    updateIngestOrb(orb, { step: "Done", pct: 100 });
    resolveIngestOrb(orb, { id: "new-paper", cluster_path: "Brand New/Leaf" }, 100);
    stepIngestOrb(orb, frame(500));
    expect(orb.motion.phase).toBe("resolved");
    expect(suppressedPaperId(orb)).toBeNull();

    stepIngestOrb(orb, frame(1_000, { finalTarget: { x: 333, y: 222 } }));
    expect(suppressedPaperId(orb)).toBe("new-paper");
    stepIngestOrb(orb, frame(1_350, { finalTarget: { x: 410, y: 260 } }));
    expect(orb.position.x).toBeGreaterThan(333);
    stepIngestOrb(orb, frame(1_700, { finalTarget: { x: 430, y: 280 } }));
    expect(orb.motion.phase).toBe("complete");
    expect(orb.position).toEqual({ x: 430, y: 280 });
    expect(suppressedPaperId(orb)).toBeNull();
    vi.useRealTimers();
  });

  it("uses a bounded panel-center orbit with no anchors for a first upload", () => {
    const orb = createIngestOrbState(1, "first", 0, bounds, false);
    updateIngestOrb(orb, { step: "Embedding", pct: 50 });
    for (let now = 100; now <= 2_000; now += 100) stepIngestOrb(orb, frame(now, { anchors: [] }));
    expect(orb.lastTargetPath).toBeNull();
    expect(orb.position.x).toBeGreaterThan(bounds.minX);
    expect(orb.position.x).toBeLessThan(bounds.maxX);
    resolveIngestOrb(orb, { id: "first", cluster_path: null }, 2_100);
    stepIngestOrb(orb, frame(2_200, { anchors: [], finalTarget: { x: 400, y: 300 } }));
    expect(suppressedPaperId(orb)).toBe("first");
  });

  it("times out a missing final node without choosing any fallback destination", () => {
    const orb = createIngestOrbState(1, "delayed", 0, bounds, false);
    resolveIngestOrb(orb, { id: "missing", cluster_path: "Unknown" }, 100);
    stepIngestOrb(orb, frame(1_101, { resolutionTimeoutMs: 1_000 }));
    expect(orb.motion).toMatchObject({ phase: "canceled", terminalReason: "timeout" });
    expect(suppressedPaperId(orb)).toBeNull();
  });

  it.each([10, 40, 75, 95])("cancels idempotently after an error at %s%%", pct => {
    const orb = createIngestOrbState(1, "error", 0, bounds, false);
    updateIngestOrb(orb, { step: "Working", pct });
    cancelIngestOrb(orb, 500);
    cancelIngestOrb(orb, 900);
    expect(orb.motion).toMatchObject({ phase: "canceled", terminalAt: 500 });
    expect(ingestOrbOpacity(orb, 500 + INGEST_CANCEL_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(shouldRemoveIngestOrb(orb, 500 + INGEST_CANCEL_FADE_MS)).toBe(true);
  });

  it("uses a stationary reduced-motion marker and short crossfade", () => {
    const orb = createIngestOrbState(1, "quiet", 0, bounds, true);
    updateIngestOrb(orb, { step: "Embedding", pct: 60 });
    stepIngestOrb(orb, frame(100, { reducedMotion: true, pointer: { x: 400, y: 300 } }));
    expect(orb.position).toEqual({ x: 400, y: 300 });
    resolveIngestOrb(orb, { id: "quiet-paper", cluster_path: "Alpha/Leaf" }, 200);
    stepIngestOrb(orb, frame(300, { reducedMotion: true, finalTarget: { x: 220, y: 190 } }));
    stepIngestOrb(orb, frame(520, { reducedMotion: true, finalTarget: { x: 220, y: 190 } }));
    expect(orb.motion.phase).toBe("complete");
    expect(shouldRemoveIngestOrb(orb, 740)).toBe(true);
  });
});
