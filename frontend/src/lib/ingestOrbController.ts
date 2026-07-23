import {
  advanceIngestProgress,
  applyPointerRepulsion,
  cancelIngestMotion,
  completeIngestMotion,
  createIngestMotionState,
  getPhaseEnvelope,
  orderExplorationTargets,
  resolveIngestMotion,
  timeoutIngestMotion,
  type IngestMotionState,
  type IngestProgress,
  type MotionBounds,
  type Point,
} from "./ingestMotion";

export interface IngestExplorationAnchor extends Point {
  path: string;
}

export interface IngestOrbState {
  id: number;
  seed: string;
  motion: IngestMotionState;
  position: Point;
  createdAt: number;
  lastTargetPath: string | null;
  finalPaperId: string | null;
  finalClusterPath: string | null;
  morphStartedAt: number | null;
  completedAt: number | null;
  reducedMotion: boolean;
}

export interface IngestOrbFrame {
  now: number;
  dt: number;
  bounds: MotionBounds;
  anchors: readonly IngestExplorationAnchor[];
  pointer: Point | null;
  finalTarget: Point | null;
  reducedMotion: boolean;
  resolutionTimeoutMs?: number;
}

export const INGEST_RESOLUTION_TIMEOUT_MS = 12_000;
export const INGEST_CANCEL_FADE_MS = 400;
export const INGEST_MORPH_MS = 700;
export const INGEST_REDUCED_MORPH_MS = 220;
export const INGEST_RIPPLE_MS = 700;

function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

function centerOf(bounds: MotionBounds): Point {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

export function createIngestOrbState(
  id: number,
  seed: string,
  now: number,
  bounds: MotionBounds,
  reducedMotion: boolean,
): IngestOrbState {
  const center = centerOf(bounds);
  const edge = hash(seed) % 4;
  const fraction = ((hash(`${seed}:edge`) % 800) + 100) / 1000;
  const position = reducedMotion ? center : edge === 0
    ? { x: bounds.minX, y: bounds.minY + (bounds.maxY - bounds.minY) * fraction }
    : edge === 1
      ? { x: bounds.maxX, y: bounds.minY + (bounds.maxY - bounds.minY) * fraction }
      : edge === 2
        ? { x: bounds.minX + (bounds.maxX - bounds.minX) * fraction, y: bounds.minY }
        : { x: bounds.minX + (bounds.maxX - bounds.minX) * fraction, y: bounds.maxY };

  return {
    id,
    seed,
    motion: createIngestMotionState(),
    position,
    createdAt: now,
    lastTargetPath: null,
    finalPaperId: null,
    finalClusterPath: null,
    morphStartedAt: null,
    completedAt: null,
    reducedMotion,
  };
}

export function updateIngestOrb(state: IngestOrbState, progress: IngestProgress): void {
  state.motion = advanceIngestProgress(state.motion, progress);
}

export function resolveIngestOrb(
  state: IngestOrbState,
  paper: { id: string; cluster_path: string | null },
  now: number,
): void {
  const next = resolveIngestMotion(state.motion, now);
  if (next === state.motion) return;
  state.motion = next;
  state.finalPaperId = paper.id;
  state.finalClusterPath = paper.cluster_path;
}

export function cancelIngestOrb(state: IngestOrbState, now: number): void {
  state.motion = cancelIngestMotion(state.motion, now);
  state.morphStartedAt = null;
}

function explorationTarget(state: IngestOrbState, frame: IngestOrbFrame): Point {
  const center = centerOf(frame.bounds);
  const orderedPaths = orderExplorationTargets(state.seed, frame.anchors.map(anchor => anchor.path));
  const anchorsByPath = new Map(frame.anchors.map(anchor => [anchor.path, anchor]));
  let anchor: IngestExplorationAnchor | undefined;

  if (orderedPaths.length) {
    if (state.motion.phase === "survey") {
      const index = Math.floor(Math.max(0, state.motion.pct - 30) / 10) % orderedPaths.length;
      state.lastTargetPath = orderedPaths[index];
    } else if (state.motion.phase === "narrowing") {
      const count = Math.min(3, orderedPaths.length);
      const index = Math.floor(Math.max(0, state.motion.pct - 70) / 10) % count;
      state.lastTargetPath = orderedPaths[index];
    } else if (!state.lastTargetPath) {
      state.lastTargetPath = orderedPaths[0];
    }
    anchor = anchorsByPath.get(state.lastTargetPath ?? "") ?? anchorsByPath.get(orderedPaths[0]);
  } else {
    state.lastTargetPath = null;
  }

  if (state.motion.phase === "arrival") return center;
  const envelope = getPhaseEnvelope(state.motion.phase, state.motion.pct, frame.reducedMotion);
  const base = anchor ?? center;
  const orbitRadius = anchor ? envelope.orbitRadius : Math.max(10, Math.min(28, (frame.bounds.maxX - frame.bounds.minX) * 0.035));
  const direction = hash(`${state.seed}:orbit`) % 2 ? 1 : -1;
  const angle = direction * (frame.now - state.createdAt) * 0.0012 + (hash(state.seed) % 628) / 100;
  return {
    x: base.x + Math.cos(angle) * orbitRadius,
    y: base.y + Math.sin(angle) * orbitRadius,
  };
}

export function stepIngestOrb(state: IngestOrbState, frame: IngestOrbFrame): void {
  state.reducedMotion = frame.reducedMotion;
  if (state.motion.phase === "resolved") {
    state.motion = timeoutIngestMotion(
      state.motion,
      frame.now,
      frame.resolutionTimeoutMs ?? INGEST_RESOLUTION_TIMEOUT_MS,
    );
    if (state.motion.phase === "canceled") {
      state.morphStartedAt = null;
      return;
    }
    if (frame.finalTarget) {
      if (state.morphStartedAt === null) state.morphStartedAt = frame.now;
      const duration = frame.reducedMotion ? INGEST_REDUCED_MORPH_MS : INGEST_MORPH_MS;
      const progress = Math.min(1, (frame.now - state.morphStartedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      state.position.x += (frame.finalTarget.x - state.position.x) * eased;
      state.position.y += (frame.finalTarget.y - state.position.y) * eased;
      if (progress >= 1) {
        state.position = { ...frame.finalTarget };
        state.motion = completeIngestMotion(state.motion, frame.now);
        state.completedAt = frame.now;
        state.morphStartedAt = null;
      }
    }
    return;
  }
  if (state.motion.phase === "canceled" || state.motion.phase === "complete") return;

  const center = centerOf(frame.bounds);
  if (frame.reducedMotion) {
    state.position = center;
    return;
  }
  const target = explorationTarget(state, frame);
  if (frame.pointer) {
    const repelled = applyPointerRepulsion(state.position, frame.pointer, frame.bounds, {
      phase: state.motion.phase,
      radius: 110,
      maxOffset: 16,
    });
    target.x += repelled.x - state.position.x;
    target.y += repelled.y - state.position.y;
  }
  const envelope = getPhaseEnvelope(state.motion.phase, state.motion.pct);
  const alpha = 1 - Math.exp(-(2.4 + envelope.speed * 2.2) * Math.min(0.032, Math.max(0, frame.dt)));
  state.position.x += (target.x - state.position.x) * alpha;
  state.position.y += (target.y - state.position.y) * alpha;
  state.position.x = Math.min(frame.bounds.maxX, Math.max(frame.bounds.minX, state.position.x));
  state.position.y = Math.min(frame.bounds.maxY, Math.max(frame.bounds.minY, state.position.y));
}

export function suppressedPaperId(state: IngestOrbState): string | null {
  return state.motion.phase === "resolved" && state.morphStartedAt !== null ? state.finalPaperId : null;
}

export function ingestOrbOpacity(state: IngestOrbState, now: number): number {
  if (state.motion.phase === "canceled") {
    return Math.max(0, 1 - (now - (state.motion.terminalAt ?? now)) / INGEST_CANCEL_FADE_MS);
  }
  if (state.motion.phase === "complete") return 0;
  if (state.motion.phase === "resolved" && state.morphStartedAt !== null) {
    const duration = state.reducedMotion ? INGEST_REDUCED_MORPH_MS : INGEST_MORPH_MS;
    return Math.max(0, 1 - (now - state.morphStartedAt) / duration);
  }
  return 1;
}

export function shouldRemoveIngestOrb(state: IngestOrbState, now: number): boolean {
  if (state.motion.phase === "canceled") {
    return now - (state.motion.terminalAt ?? now) >= INGEST_CANCEL_FADE_MS;
  }
  if (state.motion.phase === "complete") {
    const linger = state.reducedMotion ? INGEST_REDUCED_MORPH_MS : INGEST_RIPPLE_MS;
    return now - (state.completedAt ?? now) >= linger;
  }
  return false;
}
