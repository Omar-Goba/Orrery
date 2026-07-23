export type IngestPhase =
  | "arrival"
  | "survey"
  | "narrowing"
  | "holding"
  | "resolved"
  | "canceled"
  | "complete";

export interface IngestProgress {
  step: string;
  pct: number;
}

export interface IngestMotionState extends IngestProgress {
  phase: IngestPhase;
  resolvedAt?: number;
  terminalAt?: number;
  terminalReason?: "canceled" | "timeout" | "complete";
}

export interface Point {
  x: number;
  y: number;
}

export interface MotionBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface PhaseEnvelope {
  progress: number;
  intensity: number;
  speed: number;
  pull: number;
  orbitRadius: number;
  pulseMs: number;
}

export interface PointerResponseOptions {
  radius?: number;
  maxOffset?: number;
  phase?: IngestPhase;
  reducedMotion?: boolean;
}

const ROGUE_TARGETS = new Set(["misc", "unclustered"]);
const ACTIVE_PHASES = new Set<IngestPhase>(["arrival", "survey", "narrowing", "holding"]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePct(pct: number, fallback = 0): number {
  return Number.isFinite(pct) ? clamp(pct, 0, 100) : fallback;
}

export function mapIngestPhase({ pct }: IngestProgress): IngestPhase {
  const normalized = normalizePct(pct);
  if (normalized < 30) return "arrival";
  if (normalized < 70) return "survey";
  if (normalized < 90) return "narrowing";
  return "holding";
}

export function createIngestMotionState(progress: IngestProgress = { step: "Starting...", pct: 0 }): IngestMotionState {
  const pct = normalizePct(progress.pct);
  const normalized = { step: progress.step, pct };
  return { ...normalized, phase: mapIngestPhase(normalized) };
}

export function advanceIngestProgress(
  state: IngestMotionState,
  progress: IngestProgress,
): IngestMotionState {
  if (state.phase === "resolved" || isTerminalPhase(state.phase)) return state;

  const incomingPct = normalizePct(progress.pct, state.pct);
  if (incomingPct < state.pct) return state;

  const next = { step: progress.step, pct: incomingPct };
  return { ...state, ...next, phase: mapIngestPhase(next) };
}

export function resolveIngestMotion(state: IngestMotionState, now: number): IngestMotionState {
  if (state.phase === "resolved" || isTerminalPhase(state.phase)) return state;
  return { ...state, phase: "resolved", resolvedAt: now };
}

export function cancelIngestMotion(
  state: IngestMotionState,
  now: number,
  reason: "canceled" | "timeout" = "canceled",
): IngestMotionState {
  if (isTerminalPhase(state.phase)) return state;
  return { ...state, phase: "canceled", terminalAt: now, terminalReason: reason };
}

export function completeIngestMotion(state: IngestMotionState, now: number): IngestMotionState {
  if (isTerminalPhase(state.phase)) return state;
  return { ...state, phase: "complete", terminalAt: now, terminalReason: "complete" };
}

export function isTerminalPhase(phase: IngestPhase): boolean {
  return phase === "canceled" || phase === "complete";
}

export function isResolutionTimedOut(
  state: IngestMotionState,
  now: number,
  timeoutMs: number,
): boolean {
  return state.phase === "resolved"
    && state.resolvedAt !== undefined
    && now - state.resolvedAt >= Math.max(0, timeoutMs);
}

export function timeoutIngestMotion(
  state: IngestMotionState,
  now: number,
  timeoutMs: number,
): IngestMotionState {
  return isResolutionTimedOut(state, now, timeoutMs)
    ? cancelIngestMotion(state, now, "timeout")
    : state;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isRogueTarget(path: string): boolean {
  return ROGUE_TARGETS.has(path.split("/", 1)[0].trim().toLowerCase());
}

export function orderExplorationTargets(seed: string, targets: readonly string[]): string[] {
  const unique = [...new Set(targets.map(target => target.trim()).filter(Boolean))];
  const generated = unique.filter(target => !isRogueTarget(target));
  const eligible = generated.length > 0 ? generated : unique;

  return eligible.sort((a, b) => {
    const score = hashString(`${seed}\0${a}`) - hashString(`${seed}\0${b}`);
    return score || a.localeCompare(b);
  });
}

function phaseProgress(phase: IngestPhase, pct: number): number {
  if (phase === "arrival") return clamp(pct / 29, 0, 1);
  if (phase === "survey") return clamp((pct - 30) / 39, 0, 1);
  if (phase === "narrowing") return clamp((pct - 70) / 19, 0, 1);
  if (phase === "holding") return clamp((pct - 90) / 10, 0, 1);
  return 1;
}

export function getPhaseEnvelope(
  phase: IngestPhase,
  pct: number,
  reducedMotion = false,
): PhaseEnvelope {
  const progress = phaseProgress(phase, normalizePct(pct));
  const intensity = phase === "canceled" ? 0 : phase === "complete" ? 0.35 : 0.45 + progress * 0.55;

  if (reducedMotion || phase === "resolved" || isTerminalPhase(phase)) {
    return { progress, intensity, speed: 0, pull: 0, orbitRadius: 0, pulseMs: 0 };
  }
  if (phase === "arrival") {
    return { progress, intensity, speed: 0.55 + progress * 0.25, pull: 0.35 + progress * 0.25, orbitRadius: 0, pulseMs: 1500 };
  }
  if (phase === "survey") {
    return { progress, intensity, speed: 0.75 + progress * 0.45, pull: 0.55 + progress * 0.35, orbitRadius: 28 - progress * 6, pulseMs: 1100 - progress * 250 };
  }
  if (phase === "narrowing") {
    return { progress, intensity, speed: 0.62 - progress * 0.12, pull: 0.9 + progress * 0.25, orbitRadius: 16 - progress * 6, pulseMs: 900 + progress * 250 };
  }
  return { progress, intensity, speed: 0.28, pull: 0.8, orbitRadius: 8, pulseMs: 1400 };
}

export function clampPointToBounds(point: Point, bounds: MotionBounds): Point {
  const minX = Math.min(bounds.minX, bounds.maxX);
  const maxX = Math.max(bounds.minX, bounds.maxX);
  const minY = Math.min(bounds.minY, bounds.maxY);
  const maxY = Math.max(bounds.minY, bounds.maxY);
  return { x: clamp(point.x, minX, maxX), y: clamp(point.y, minY, maxY) };
}

export function applyPointerRepulsion(
  orb: Point,
  pointer: Point,
  bounds: MotionBounds,
  options: PointerResponseOptions = {},
): Point {
  const phase = options.phase ?? "survey";
  if (options.reducedMotion || !ACTIVE_PHASES.has(phase)) return clampPointToBounds(orb, bounds);

  const radius = Math.max(0, options.radius ?? 120);
  const maxOffset = Math.max(0, options.maxOffset ?? 18);
  const dx = orb.x - pointer.x;
  const dy = orb.y - pointer.y;
  const distance = Math.hypot(dx, dy);
  if (radius === 0 || maxOffset === 0 || distance >= radius) return clampPointToBounds(orb, bounds);

  const strength = maxOffset * (1 - distance / radius) ** 2;
  const directionX = distance === 0 ? 1 : dx / distance;
  const directionY = distance === 0 ? 0 : dy / distance;
  return clampPointToBounds(
    { x: orb.x + directionX * strength, y: orb.y + directionY * strength },
    bounds,
  );
}
