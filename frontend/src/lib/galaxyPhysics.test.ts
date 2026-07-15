import { describe, expect, it } from "vitest";
import {
  createGalaxyPhysicsConfig,
  createGalaxyPhysicsState,
  precomputeAmbientMotion,
  precomputeHierarchyAnchors,
  stepGalaxyPhysics,
  type GalaxyAnchor,
  type GalaxyBounds,
  type GalaxySimulationNode,
} from "./galaxyPhysics";

const BOUNDS: GalaxyBounds = { minX: -500, maxX: 500, minY: -500, maxY: 500 };

function node(
  id: string,
  x: number,
  y: number,
  anchors: readonly GalaxyAnchor[] = [],
): GalaxySimulationNode {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    anchors,
    ambient: precomputeAmbientMotion(id),
    drag: null,
  };
}

function run(nodes: GalaxySimulationNode[], seconds: number, dt: number, config = createGalaxyPhysicsConfig()) {
  const state = createGalaxyPhysicsState(nodes.length);
  for (let elapsed = 0; elapsed < seconds - 1e-12; elapsed += dt) {
    stepGalaxyPhysics(state, nodes, BOUNDS, Math.min(dt, seconds - elapsed), config);
  }
  return state;
}

describe("galaxyPhysics", () => {
  it("produces deterministic results for identical inputs", () => {
    const anchors = precomputeHierarchyAnchors("A/B", {
      A: { x: 10, y: 5 },
      "A/B": { x: 30, y: 20 },
    });
    const first = [node("a", 0, 0, anchors), node("b", 8, 2, anchors)];
    const second = [node("a", 0, 0, anchors), node("b", 8, 2, anchors)];

    run(first, 1, 1 / 60);
    run(second, 1, 1 / 60);

    expect(first).toEqual(second);
  });

  it("is approximately frame-rate independent for equal elapsed time", () => {
    const anchor = [{ x: 100, y: 20, strength: 2 }];
    const at60 = [node("a", -20, 0, anchor), node("b", 20, 0, anchor)];
    const at120 = [node("a", -20, 0, anchor), node("b", 20, 0, anchor)];

    run(at60, 2, 1 / 60);
    run(at120, 2, 1 / 120);

    expect(at60[0].x).toBeCloseTo(at120[0].x, 10);
    expect(at60[0].y).toBeCloseTo(at120[0].y, 10);
    expect(at60[1].x).toBeCloseTo(at120[1].x, 10);
    expect(at60[1].y).toBeCloseTo(at120[1].y, 10);
  });

  it("caps a background-resume time step", () => {
    const config = createGalaxyPhysicsConfig({
      repulsionStrength: 0,
      ambientAcceleration: 0,
      damping: 0,
      maxSpeed: 1_000,
    });
    const resumed = node("resume", 0, 0);
    resumed.vx = 100;
    const normal = node("normal", 0, 0);
    normal.vx = 100;

    stepGalaxyPhysics(createGalaxyPhysicsState(), [resumed], BOUNDS, 10, config);
    stepGalaxyPhysics(createGalaxyPhysicsState(), [normal], BOUNDS, config.maxDt, config);

    expect(resumed.x).toBe(normal.x);
    expect(resumed.x).toBeLessThan(4);
  });

  it("finds all nearby cross-cell pairs, excludes distant cells, and applies each pair once", () => {
    const config = createGalaxyPhysicsConfig({
      cellSize: 10,
      repulsionRadius: 12,
      repulsionStrength: 100,
      repulsionSoftening: 0,
      maxPairAcceleration: 1_000,
      damping: 0,
      ambientAcceleration: 0,
      maxSubstep: 1,
    });
    const nodes = [node("left", 9, 0), node("right", 11, 0), node("far", 51, 0)];
    const state = createGalaxyPhysicsState();

    stepGalaxyPhysics(state, nodes, BOUNDS, 0.01, config);

    expect(state.nearbyPairCount).toBe(1);
    expect(state.candidatePairCount).toBe(1);
    expect(nodes[0].vx).toBeCloseTo(-0.25);
    expect(nodes[1].vx).toBeCloseTo(0.25);
    expect(nodes[2].vx).toBe(0);
  });

  it("separates exactly overlapping nodes without non-finite values", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 0)];

    run(nodes, 0.1, 1 / 60, createGalaxyPhysicsConfig({ ambientAcceleration: 0 }));

    expect(Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y)).toBeGreaterThan(0);
    for (const value of nodes.flatMap(({ x, y, vx, vy }) => [x, y, vx, vy])) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("returns displaced nodes toward precomputed hierarchical anchors", () => {
    const anchors = precomputeHierarchyAnchors("Outer/Inner", {
      Outer: { x: 60, y: 0 },
      "Outer/Inner": { x: 100, y: 0 },
    });
    const pulled = node("pulled", -100, 0, anchors);
    const startDistance = 200;

    run([pulled], 1, 1 / 60, createGalaxyPhysicsConfig({ ambientAcceleration: 0 }));

    expect(Math.abs(100 - pulled.x)).toBeLessThan(startDistance);
    expect(anchors).toEqual([
      { x: 60, y: 0, strength: 1.7 },
      { x: 100, y: 0, strength: 3.4 },
    ]);
  });

  it("locks a dragged node while it continues repelling its neighbor", () => {
    const held = node("held", 0, 0);
    held.drag = { x: 5, y: 7 };
    const neighbor = node("neighbor", 8, 0);

    run([held, neighbor], 0.1, 1 / 60, createGalaxyPhysicsConfig({ ambientAcceleration: 0 }));

    expect(held).toMatchObject({ x: 5, y: 7, vx: 0, vy: 0 });
    expect(neighbor.x).toBeGreaterThan(8);
  });

  it("caps speed and reflects nodes inside normalized bounds", () => {
    const config = createGalaxyPhysicsConfig({
      repulsionStrength: 0,
      ambientAcceleration: 0,
      damping: 0,
      maxSpeed: 10,
      boundaryRestitution: 0.25,
    });
    const bounded = node("bounded", 9.9, 5);
    bounded.vx = 1_000;

    stepGalaxyPhysics(
      createGalaxyPhysicsState(),
      [bounded],
      { minX: 10, maxX: -10, minY: 10, maxY: -10 },
      0.032,
      config,
    );

    expect(bounded.x).toBeGreaterThanOrEqual(-10);
    expect(bounded.x).toBeLessThanOrEqual(10);
    expect(bounded.vx).toBeLessThan(0);
    expect(Math.hypot(bounded.vx, bounded.vy)).toBeLessThanOrEqual(config.maxSpeed);
  });

  it("keeps deterministic ambient motion calm and bounded around an anchor", () => {
    const anchor = [{ x: 0, y: 0, strength: 1.5 }];
    const moving = node("ambient", 40, 0, anchor);
    const samples: number[] = [];
    const state = createGalaxyPhysicsState();
    const config = createGalaxyPhysicsConfig({ repulsionStrength: 0 });

    for (let i = 0; i < 30 * 60; i++) {
      stepGalaxyPhysics(state, [moving], BOUNDS, 1 / 60, config);
      samples.push(Math.hypot(moving.x, moving.y));
    }

    expect(Math.max(...samples)).toBeLessThan(41);
    expect(Math.min(...samples)).toBeGreaterThan(0);
    expect(Math.hypot(moving.vx, moving.vy)).toBeLessThan(5);
    expect(Math.abs(moving.y)).toBeGreaterThan(0.01);
  });

  it("handles empty, single-node, zero-anchor, and multi-anchor simulations", () => {
    const state = createGalaxyPhysicsState();
    expect(() => stepGalaxyPhysics(state, [], BOUNDS, 1 / 60)).not.toThrow();

    const zeroAnchor = node("zero", 1, 2, []);
    const multiAnchor = node("multi", 10, 10, [
      { x: 5, y: 5, strength: 1 },
      { x: 0, y: 0, strength: 2 },
    ]);
    expect(() => run([zeroAnchor], 0.1, 1 / 60)).not.toThrow();
    expect(() => run([multiAnchor], 0.1, 1 / 60)).not.toThrow();
    expect([zeroAnchor, multiAnchor].every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("precomputes stable ambient values per seed", () => {
    expect(precomputeAmbientMotion("paper-42")).toEqual(precomputeAmbientMotion("paper-42"));
    expect(precomputeAmbientMotion("paper-42")).not.toEqual(precomputeAmbientMotion("paper-43"));
  });
});
