export interface GalaxyPoint {
  x: number;
  y: number;
}

export interface GalaxyAnchor extends GalaxyPoint {
  strength: number;
}

export interface GalaxyBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export type GalaxyDragConstraint = GalaxyPoint;

export interface GalaxyAmbientMotion {
  phase: number;
  frequency: number;
  strength: number;
  direction: 1 | -1;
}

export interface GalaxySimulationNode extends GalaxyPoint {
  vx: number;
  vy: number;
  anchors: readonly GalaxyAnchor[];
  ambient: GalaxyAmbientMotion;
  drag: GalaxyDragConstraint | null;
  recovery: number;
}

export interface GalaxyPhysicsConfig {
  maxDt: number;
  maxSubstep: number;
  cellSize: number;
  repulsionRadius: number;
  repulsionStrength: number;
  repulsionSoftening: number;
  maxPairAcceleration: number;
  damping: number;
  maxSpeed: number;
  boundaryRestitution: number;
  ambientAcceleration: number;
  ambientMaxSpeed: number;
  recoverySeconds: number;
  recoveryAttraction: number;
  recoveryDampingRatio: number;
}

export interface GalaxyPhysicsState {
  elapsed: number;
  candidatePairCount: number;
  nearbyPairCount: number;
  hashHeads: Int32Array;
  hashNext: Int32Array;
  cellX: Int32Array;
  cellY: Int32Array;
}

export const DEFAULT_GALAXY_PHYSICS_CONFIG: Readonly<GalaxyPhysicsConfig> = {
  maxDt: 0.032,
  maxSubstep: 1 / 120,
  cellSize: 200,
  repulsionRadius: 200,
  repulsionStrength: 36_000,
  repulsionSoftening: 8,
  maxPairAcceleration: 1_200,
  damping: 3.8,
  maxSpeed: 120,
  boundaryRestitution: 0.3,
  ambientAcceleration: 3.2,
  ambientMaxSpeed: 0.7,
  recoverySeconds: 2.4,
  recoveryAttraction: 2,
  recoveryDampingRatio: 1.05,
};

export function createGalaxyPhysicsConfig(
  overrides: Partial<GalaxyPhysicsConfig> = {},
): GalaxyPhysicsConfig {
  return { ...DEFAULT_GALAXY_PHYSICS_CONFIG, ...overrides };
}

export function createGalaxyPhysicsState(initialCapacity = 0): GalaxyPhysicsState {
  const nodeCapacity = Math.max(0, initialCapacity);
  const hashCapacity = hashCapacityFor(nodeCapacity);
  return {
    elapsed: 0,
    candidatePairCount: 0,
    nearbyPairCount: 0,
    hashHeads: new Int32Array(hashCapacity),
    hashNext: new Int32Array(nodeCapacity),
    cellX: new Int32Array(nodeCapacity),
    cellY: new Int32Array(nodeCapacity),
  };
}

/** Build the ordered anchor list once when a node's cluster path changes. */
export function precomputeHierarchyAnchors(
  path: string | null | undefined,
  centers: Readonly<Record<string, GalaxyPoint | undefined>>,
  baseStrength = 1.7,
): GalaxyAnchor[] {
  if (!path) return [];
  const parts = path.split("/");
  const anchors: GalaxyAnchor[] = [];
  let prefix = "";
  for (let depth = 0; depth < parts.length; depth++) {
    prefix = depth === 0 ? parts[depth] : `${prefix}/${parts[depth]}`;
    const center = centers[prefix];
    if (center) {
      anchors.push({ x: center.x, y: center.y, strength: baseStrength * (depth + 1) });
    }
  }
  return anchors;
}

/** Precompute calm, deterministic orbital parameters from a stable visual seed. */
export function precomputeAmbientMotion(seed: string, strength = 1): GalaxyAmbientMotion {
  return {
    phase: hash01(seed, 0x68bc21eb) * Math.PI * 2,
    frequency: 0.12 + hash01(seed, 0x02e5be93) * 0.08,
    strength: strength * (0.75 + hash01(seed, 0x7f4a7c15) * 0.5),
    direction: hash01(seed, 0x165667b1) < 0.5 ? -1 : 1,
  };
}

/** Start a critically damped return for a released node and neighbors it displaced. */
export function recoverGalaxyAfterDrag(
  nodes: GalaxySimulationNode[],
  released: GalaxySimulationNode,
  radius = DEFAULT_GALAXY_PHYSICS_CONFIG.repulsionRadius,
): void {
  const radiusSquared = radius * radius;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const dx = node.x - released.x;
    const dy = node.y - released.y;
    if (node === released || dx * dx + dy * dy <= radiusSquared) node.recovery = 1;
  }
}

/**
 * Advance reusable node objects in place. The spatial workspace only grows when
 * node count exceeds its prior capacity; steady-state substeps allocate nothing.
 */
export function stepGalaxyPhysics(
  state: GalaxyPhysicsState,
  nodes: GalaxySimulationNode[],
  bounds: GalaxyBounds,
  dt: number,
  config: Readonly<GalaxyPhysicsConfig> = DEFAULT_GALAXY_PHYSICS_CONFIG,
): void {
  state.candidatePairCount = 0;
  state.nearbyPairCount = 0;
  if (!Number.isFinite(dt) || dt <= 0 || nodes.length === 0) return;

  ensureCapacity(state, nodes.length);
  const cappedDt = Math.min(dt, config.maxDt);
  const substepCount = Math.max(1, Math.ceil(cappedDt / config.maxSubstep));
  const subDt = cappedDt / substepCount;

  for (let substep = 0; substep < substepCount; substep++) {
    state.elapsed += subDt;
    populateSpatialHash(state, nodes, config.cellSize);
    applyRepulsion(state, nodes, subDt, config);
    integrateNodes(state.elapsed, nodes, bounds, subDt, config);
  }
}

function ensureCapacity(state: GalaxyPhysicsState, nodeCount: number): void {
  if (state.hashNext.length < nodeCount) {
    state.hashNext = new Int32Array(nodeCount);
    state.cellX = new Int32Array(nodeCount);
    state.cellY = new Int32Array(nodeCount);
  }
  const requiredHashCapacity = hashCapacityFor(nodeCount);
  if (state.hashHeads.length < requiredHashCapacity) {
    state.hashHeads = new Int32Array(requiredHashCapacity);
  }
}

function hashCapacityFor(nodeCount: number): number {
  let capacity = 16;
  while (capacity < nodeCount * 4) capacity *= 2;
  return capacity;
}

function hashCell(x: number, y: number, mask: number): number {
  return (Math.imul(x, 73_856_093) ^ Math.imul(y, 19_349_663)) & mask;
}

function populateSpatialHash(
  state: GalaxyPhysicsState,
  nodes: GalaxySimulationNode[],
  cellSize: number,
): void {
  state.hashHeads.fill(-1);
  const mask = state.hashHeads.length - 1;
  for (let i = 0; i < nodes.length; i++) {
    const cx = Math.floor(nodes[i].x / cellSize);
    const cy = Math.floor(nodes[i].y / cellSize);
    state.cellX[i] = cx;
    state.cellY[i] = cy;
    const slot = hashCell(cx, cy, mask);
    state.hashNext[i] = state.hashHeads[slot];
    state.hashHeads[slot] = i;
  }
}

function applyRepulsion(
  state: GalaxyPhysicsState,
  nodes: GalaxySimulationNode[],
  dt: number,
  config: Readonly<GalaxyPhysicsConfig>,
): void {
  const radiusSquared = config.repulsionRadius * config.repulsionRadius;
  const softeningSquared = config.repulsionSoftening * config.repulsionSoftening;
  const cellRange = Math.ceil(config.repulsionRadius / config.cellSize);
  const mask = state.hashHeads.length - 1;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const homeCellX = state.cellX[i];
    const homeCellY = state.cellY[i];
    for (let offsetY = -cellRange; offsetY <= cellRange; offsetY++) {
      const queryY = homeCellY + offsetY;
      for (let offsetX = -cellRange; offsetX <= cellRange; offsetX++) {
        const queryX = homeCellX + offsetX;
        let j = state.hashHeads[hashCell(queryX, queryY, mask)];
        while (j !== -1) {
          if (j > i && state.cellX[j] === queryX && state.cellY[j] === queryY) {
            state.candidatePairCount++;
            const other = nodes[j];
            let dx = other.x - node.x;
            let dy = other.y - node.y;
            let distanceSquared = dx * dx + dy * dy;
            if (distanceSquared < radiusSquared) {
              state.nearbyPairCount++;
              if (distanceSquared < 1e-12) {
                const angle = overlapAngle(i, j, node.ambient.phase, other.ambient.phase);
                dx = Math.cos(angle);
                dy = Math.sin(angle);
                distanceSquared = 1;
              }
              const distance = Math.sqrt(distanceSquared);
              const acceleration = Math.min(
                config.maxPairAcceleration,
                config.repulsionStrength / (distanceSquared + softeningSquared),
              );
              const impulseX = (dx / distance) * acceleration * dt;
              const impulseY = (dy / distance) * acceleration * dt;
              node.vx -= impulseX;
              node.vy -= impulseY;
              other.vx += impulseX;
              other.vy += impulseY;
            }
          }
          j = state.hashNext[j];
        }
      }
    }
  }
}

function integrateNodes(
  elapsed: number,
  nodes: GalaxySimulationNode[],
  bounds: GalaxyBounds,
  dt: number,
  config: Readonly<GalaxyPhysicsConfig>,
): void {
  const minX = Math.min(bounds.minX, bounds.maxX);
  const maxX = Math.max(bounds.minX, bounds.maxX);
  const minY = Math.min(bounds.minY, bounds.maxY);
  const maxY = Math.max(bounds.minY, bounds.maxY);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const recovery = clamp(node.recovery, 0, 1);
    const attractionScale = 1 + recovery * config.recoveryAttraction;
    let anchorStrength = 0;
    for (let anchorIndex = 0; anchorIndex < node.anchors.length; anchorIndex++) {
      const anchor = node.anchors[anchorIndex];
      anchorStrength += anchor.strength;
      node.vx += (anchor.x - node.x) * anchor.strength * attractionScale * dt;
      node.vy += (anchor.y - node.y) * anchor.strength * attractionScale * dt;
    }

    const ambientAnchor = node.anchors[node.anchors.length - 1];
    if (ambientAnchor && config.ambientAcceleration !== 0 && config.ambientMaxSpeed > 0 &&
        node.ambient.strength !== 0 && recovery < 1) {
      const dx = node.x - ambientAnchor.x;
      const dy = node.y - ambientAnchor.y;
      const distance = Math.hypot(dx, dy);
      const pulse = 0.88 + Math.sin(elapsed * node.ambient.frequency + node.ambient.phase) * 0.12;
      let tangentX: number;
      let tangentY: number;
      if (distance > 1e-6) {
        tangentX = (-dy / distance) * node.ambient.direction;
        tangentY = (dx / distance) * node.ambient.direction;
      } else {
        tangentX = Math.cos(node.ambient.phase) * node.ambient.direction;
        tangentY = Math.sin(node.ambient.phase) * node.ambient.direction;
      }
      const tangentialSpeed = node.vx * tangentX + node.vy * tangentY;
      const speedHeadroom = clamp(1 - tangentialSpeed / config.ambientMaxSpeed, 0, 1);
      const acceleration = config.ambientAcceleration * node.ambient.strength * pulse
        * speedHeadroom * (1 - recovery);
      node.vx += tangentX * acceleration * dt;
      node.vy += tangentY * acceleration * dt;
    }

    const criticalDamping = Math.max(
      config.damping,
      2 * Math.sqrt(anchorStrength * attractionScale) * config.recoveryDampingRatio,
    );
    const dampingRate = config.damping + recovery * (criticalDamping - config.damping);
    const damping = Math.exp(-dampingRate * dt);
    node.vx *= damping;
    node.vy *= damping;

    if (node.drag) {
      node.x = clamp(node.drag.x, minX, maxX);
      node.y = clamp(node.drag.y, minY, maxY);
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    if (node.recovery > 0) {
      node.recovery = Math.max(0, node.recovery - dt / config.recoverySeconds);
    }

    const speed = Math.hypot(node.vx, node.vy);
    if (speed > config.maxSpeed) {
      const scale = config.maxSpeed / speed;
      node.vx *= scale;
      node.vy *= scale;
    }

    node.x += node.vx * dt;
    node.y += node.vy * dt;
    if (node.x < minX) {
      node.x = minX;
      node.vx = Math.abs(node.vx) * config.boundaryRestitution;
    } else if (node.x > maxX) {
      node.x = maxX;
      node.vx = -Math.abs(node.vx) * config.boundaryRestitution;
    }
    if (node.y < minY) {
      node.y = minY;
      node.vy = Math.abs(node.vy) * config.boundaryRestitution;
    } else if (node.y > maxY) {
      node.y = maxY;
      node.vy = -Math.abs(node.vy) * config.boundaryRestitution;
    }
  }
}

function overlapAngle(i: number, j: number, phaseA: number, phaseB: number): number {
  const mixed = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(j + 1, 0x85ebca77);
  return phaseA + phaseB + ((mixed >>> 0) / 0xffffffff) * Math.PI * 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hash01(seed: string, salt: number): number {
  let hash = salt | 0;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 0x5bd1e995);
    hash ^= hash >>> 15;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}
