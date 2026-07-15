import { describe, expect, it } from "vitest";
import {
  advanceIngestProgress,
  applyPointerRepulsion,
  cancelIngestMotion,
  clampPointToBounds,
  completeIngestMotion,
  createIngestMotionState,
  getPhaseEnvelope,
  isResolutionTimedOut,
  isTerminalPhase,
  mapIngestPhase,
  orderExplorationTargets,
  resolveIngestMotion,
  timeoutIngestMotion,
} from "./ingestMotion";

const progress = (pct: number) => ({ step: `Step ${pct}`, pct });
const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 100 };

describe("ingest phase mapping", () => {
  it.each([
    [0, "arrival"],
    [29, "arrival"],
    [30, "survey"],
    [69, "survey"],
    [70, "narrowing"],
    [89, "narrowing"],
    [90, "holding"],
    [99, "holding"],
    [100, "holding"],
  ] as const)("maps %s%% to %s", (pct, phase) => {
    expect(mapIngestPhase(progress(pct))).toBe(phase);
  });

  it("clamps out-of-range progress and treats non-finite initial progress as zero", () => {
    expect(mapIngestPhase(progress(-20))).toBe("arrival");
    expect(mapIngestPhase(progress(120))).toBe("holding");
    expect(createIngestMotionState(progress(Number.NaN))).toMatchObject({ pct: 0, phase: "arrival" });
  });

  it("does not rewind on stale or non-finite updates", () => {
    const survey = advanceIngestProgress(createIngestMotionState(progress(10)), progress(55));
    expect(advanceIngestProgress(survey, progress(20))).toBe(survey);
    expect(advanceIngestProgress(survey, progress(Number.NaN))).toMatchObject({ pct: 55, phase: "survey" });
  });

  it("keeps 100% progress holding until an explicit resolve", () => {
    const holding = advanceIngestProgress(createIngestMotionState(), progress(100));
    expect(holding.phase).toBe("holding");
    expect(resolveIngestMotion(holding, 500)).toMatchObject({ phase: "resolved", resolvedAt: 500 });
  });

  it("ignores progress after resolution", () => {
    const resolved = resolveIngestMotion(createIngestMotionState(progress(80)), 100);
    expect(advanceIngestProgress(resolved, progress(100))).toBe(resolved);
  });
});

describe("exploration target ordering", () => {
  it("is deterministic and independent of source ordering", () => {
    const targets = ["Physics/Quantum", "Biology", "Math", "Physics/Quantum"];
    const first = orderExplorationTargets("paper.pdf:42", targets);
    expect(orderExplorationTargets("paper.pdf:42", [...targets].reverse())).toEqual(first);
    expect(first).toHaveLength(3);
  });

  it("can vary target order with the upload seed", () => {
    const targets = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    expect(orderExplorationTargets("seed-a", targets)).not.toEqual(orderExplorationTargets("seed-b", targets));
  });

  it("filters rogue anchors while generated alternatives exist", () => {
    expect(orderExplorationTargets("seed", ["Misc", "Unclustered", "Real/Leaf"])).toEqual(["Real/Leaf"]);
  });

  it("retains rogue fallbacks when they are the only anchors", () => {
    expect(orderExplorationTargets("seed", ["Misc", "Unclustered"])).toHaveLength(2);
    expect(orderExplorationTargets("seed", [])).toEqual([]);
    expect(orderExplorationTargets("seed", ["Only"])).toEqual(["Only"]);
  });
});

describe("motion envelopes", () => {
  it("builds intensity within each phase and slows as narrowing settles", () => {
    const earlySurvey = getPhaseEnvelope("survey", 30);
    const lateSurvey = getPhaseEnvelope("survey", 69);
    expect(lateSurvey.speed).toBeGreaterThan(earlySurvey.speed);
    expect(lateSurvey.pull).toBeGreaterThan(earlySurvey.pull);
    expect(getPhaseEnvelope("narrowing", 89).speed).toBeLessThan(getPhaseEnvelope("narrowing", 70).speed);
  });

  it("removes continuous motion for reduced motion and terminal phases", () => {
    expect(getPhaseEnvelope("survey", 50, true)).toMatchObject({ speed: 0, pull: 0, orbitRadius: 0, pulseMs: 0 });
    expect(getPhaseEnvelope("resolved", 100)).toMatchObject({ speed: 0, orbitRadius: 0 });
    expect(getPhaseEnvelope("canceled", 50).intensity).toBe(0);
  });
});

describe("bounded pointer response", () => {
  it("pushes away only inside the response radius and caps displacement", () => {
    const orb = { x: 50, y: 50 };
    const pushed = applyPointerRepulsion(orb, { x: 45, y: 50 }, bounds, { radius: 20, maxOffset: 8 });
    expect(pushed.x).toBeGreaterThan(orb.x);
    expect(Math.hypot(pushed.x - orb.x, pushed.y - orb.y)).toBeLessThanOrEqual(8);
    expect(applyPointerRepulsion(orb, { x: 0, y: 0 }, bounds, { radius: 20 })).toEqual(orb);
  });

  it("stays in panel-safe bounds, including a coincident pointer", () => {
    expect(applyPointerRepulsion({ x: 99, y: 50 }, { x: 99, y: 50 }, bounds, { maxOffset: 20 })).toEqual({ x: 100, y: 50 });
    expect(clampPointToBounds({ x: -10, y: 120 }, bounds)).toEqual({ x: 0, y: 100 });
    expect(clampPointToBounds({ x: 10, y: 90 }, { minX: 100, maxX: 0, minY: 100, maxY: 0 })).toEqual({ x: 10, y: 90 });
  });

  it("is disabled for reduced motion and post-progress phases", () => {
    const orb = { x: 50, y: 50 };
    expect(applyPointerRepulsion(orb, { x: 49, y: 50 }, bounds, { reducedMotion: true })).toEqual(orb);
    expect(applyPointerRepulsion(orb, { x: 49, y: 50 }, bounds, { phase: "resolved" })).toEqual(orb);
    expect(applyPointerRepulsion(orb, { x: 49, y: 50 }, bounds, { phase: "complete" })).toEqual(orb);
  });
});

describe("terminal lifecycle helpers", () => {
  it("makes cancellation terminal and idempotent", () => {
    const canceled = cancelIngestMotion(createIngestMotionState(progress(50)), 200);
    expect(canceled).toMatchObject({ phase: "canceled", terminalAt: 200, terminalReason: "canceled" });
    expect(cancelIngestMotion(canceled, 300)).toBe(canceled);
    expect(completeIngestMotion(canceled, 300)).toBe(canceled);
    expect(isTerminalPhase(canceled.phase)).toBe(true);
  });

  it("completes once and ignores later terminal transitions", () => {
    const complete = completeIngestMotion(resolveIngestMotion(createIngestMotionState(), 100), 200);
    expect(complete).toMatchObject({ phase: "complete", terminalReason: "complete" });
    expect(completeIngestMotion(complete, 300)).toBe(complete);
    expect(cancelIngestMotion(complete, 300)).toBe(complete);
  });

  it("times out only a resolved state at the configured boundary", () => {
    const resolved = resolveIngestMotion(createIngestMotionState(progress(100)), 1_000);
    expect(isResolutionTimedOut(resolved, 1_999, 1_000)).toBe(false);
    expect(timeoutIngestMotion(resolved, 1_999, 1_000)).toBe(resolved);
    const timedOut = timeoutIngestMotion(resolved, 2_000, 1_000);
    expect(timedOut).toMatchObject({ phase: "canceled", terminalAt: 2_000, terminalReason: "timeout" });
    expect(timeoutIngestMotion(timedOut, 3_000, 1_000)).toBe(timedOut);
    expect(isResolutionTimedOut(createIngestMotionState(progress(100)), 2_000, 0)).toBe(false);
  });
});
