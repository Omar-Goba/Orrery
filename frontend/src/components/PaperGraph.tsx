import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PaperRecord } from "../api/client";
import type { SimilarityGraph } from "../api/client";

// ── Types ───────────────────────────────────────────────────────────────────
interface GNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  paper: PaperRecord;
  l1: string;
  colorIdx: number;
}

interface CenterInfo {
  x: number;
  y: number;
  depth: number;
  colorIdx: number;
}

// edges store [nodeA_idx, nodeB_idx, shared_path_depth]
type Edge = [number, number, number];

// View transform: screen = ((world.x * k) + tx, (world.y * k) + ty)
interface ViewTransform {
  k: number;
  tx: number;
  ty: number;
}

interface CameraAnim {
  from: ViewTransform;
  to: ViewTransform;
  start: number;
  duration: number;
  onArrive?: () => void;
}

interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
  twinkleSpeed: number;
}

interface ShootingStar {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  start: number;
  duration: number;
}

interface CitationPulse {
  id: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
}

interface Meteor {
  id: number;
  // Current position (world space once in-flight target known, else screen space drift)
  x: number;
  y: number;
  // Drift/idle state while cluster unknown
  driftPhaseX: number;
  driftPhaseY: number;
  edgeX: number;
  edgeY: number;
  centerX: number;
  centerY: number;
  // Arrival animation state
  arriving: boolean;
  arriveFrom: { x: number; y: number } | null;
  arriveTo: { x: number; y: number } | null;
  arriveStart: number;
  arriveDuration: number;
  landed: boolean;
  landedAt: number;
  canceled: boolean;
  cancelStart: number;
  createdAt: number;
}

export interface PaperGraphHandle {
  pulseCitations(paperIds: string[]): void;
  spawnMeteor(): { arrive: (clusterPath: string) => void; cancel: () => void };
  focusCluster(path: string | null): void; // null = zoom-to-fit / reset view
}

// ── Color palette ───────────────────────────────────────────────────────────
const PALETTE = [
  { stroke: "#22d3ee", glow: "rgba(34,211,238,",  dot: "rgba(34,211,238,0.8)"  },
  { stroke: "#a78bfa", glow: "rgba(167,139,250,", dot: "rgba(167,139,250,0.8)" },
  { stroke: "#34d399", glow: "rgba(52,211,153,",  dot: "rgba(52,211,153,0.8)"  },
  { stroke: "#f59e0b", glow: "rgba(245,158,11,",  dot: "rgba(245,158,11,0.8)"  },
];

// ── Physics ─────────────────────────────────────────────────────────────────
const REPULSION  = 5500;
const CENTER_K   = 0.014;   // base attraction; multiplied by (depth + 1) per level
const DAMPING    = 0.86;
const NODE_R     = 6;
const SETTLE_AT  = 300;
const MAX_FORCE  = 20;      // cap per-pair repulsion kick (px/tick)
const MAX_SPEED  = 12;      // cap node velocity so the sim can't explode (px/tick)
const ORBIT_DECAY = 0.50;   // each depth level's orbit radius = parent's × this

// ── View transform constants ────────────────────────────────────────────────
const MIN_K = 0.4;
const MAX_K = 6;
const DRAG_THRESHOLD = 4; // px — below this, mousedown→mouseup is a click, not a pan
const CAMERA_ANIM_MS = 600;

// ── Edge opacity by shared depth ────────────────────────────────────────────
// depth 1 = same L1 only (barely visible), depth 2+ = progressively stronger
const EDGE_MAX_ALPHA = [0, 0.035, 0.10, 0.18, 0.22];
function edgeMaxAlpha(depth: number): number {
  return EDGE_MAX_ALPHA[Math.min(depth, EDGE_MAX_ALPHA.length - 1)];
}

// ── Shared path depth helper ─────────────────────────────────────────────────
function sharedPathDepth(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const pa = a.split("/");
  const pb = b.split("/");
  let d = 0;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) d++;
    else break;
  }
  return d;
}

function jitter(id: string, axis: number): number {
  let hash = axis;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(31, hash) + id.charCodeAt(i);
  }
  return ((hash >>> 0) / 0xffffffff - 0.5) * 80;
}

// Deterministic 0..1 pseudo-random value derived from a string + axis, reusing
// the same hashing technique as jitter() but normalized to [0, 1) instead of
// a spawn offset in px. Handy for idle-drift phase/frequency and star seeds.
function hash01(id: string, axis: number): number {
  let hash = axis;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(31, hash) + id.charCodeAt(i);
  }
  // Ids that only differ in a trailing digit (e.g. "star-1-8" vs "star-1-9")
  // otherwise produce hashes 1 apart — an imperceptible change once divided
  // down to [0,1). Avalanche the bits (Murmur3 fmix32) so every id scatters.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0xffffffff;
}

function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Smoothly interpolate alpha across a [start, peak, end] triangular zone (or
// a simple rising ramp if end is Infinity), used for k-based LOD fades.
function triangleFade(k: number, kStart: number, kPeak: number, kEnd: number): number {
  if (k <= kStart || k >= kEnd) return 0;
  if (k <= kPeak) return (k - kStart) / Math.max(0.0001, kPeak - kStart);
  return 1 - (k - kPeak) / Math.max(0.0001, kEnd - kPeak);
}

function rampFade(k: number, kStart: number, kFull: number): number {
  if (k <= kStart) return 0;
  if (k >= kFull) return 1;
  return (k - kStart) / Math.max(0.0001, kFull - kStart);
}

let meteorIdSeq = 1;
let pulseIdSeq = 1;

// ── Component ────────────────────────────────────────────────────────────────
export const PaperGraph = forwardRef<PaperGraphHandle, {
  papers: PaperRecord[];
  onHover?: (p: PaperRecord | null) => void;
  onOpenPaper?: (p: PaperRecord) => void;
  active?: boolean;
  /** Space (px) reserved for floating UI panels; layout centers in the remaining area. */
  insets?: { left?: number; right?: number; top?: number; bottom?: number };
  /** Real embedding-space nearest neighbors, keyed by paper id. */
  similarity?: SimilarityGraph;
  /** Screen-space (CSS px) landing point for citation pulses; defaults to bottom-center. */
  pulseTarget?: { x: number; y: number };
  /** Fired when the user clicks a cluster aura/label to glide the camera there. */
  onFocusCluster?: (path: string) => void;
}>(function PaperGraph({
  papers,
  onHover,
  onOpenPaper,
  active = true,
  insets,
  similarity,
  pulseTarget,
  onFocusCluster,
}, ref) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const insetLeft   = insets?.left   ?? 55;
  const insetRight  = insets?.right  ?? 55;
  const insetTop    = insets?.top    ?? 55;
  const insetBottom = insets?.bottom ?? 55;
  const insetsRef  = useRef({ left: insetLeft, right: insetRight, top: insetTop, bottom: insetBottom });
  useEffect(() => {
    insetsRef.current = { left: insetLeft, right: insetRight, top: insetTop, bottom: insetBottom };
  }, [insetLeft, insetRight, insetTop, insetBottom]);

  const similarityRef = useRef<SimilarityGraph | undefined>(similarity);
  useEffect(() => { similarityRef.current = similarity; }, [similarity]);

  const pulseTargetRef = useRef(pulseTarget);
  useEffect(() => { pulseTargetRef.current = pulseTarget; }, [pulseTarget]);

  const onFocusClusterRef = useRef(onFocusCluster);
  useEffect(() => { onFocusClusterRef.current = onFocusCluster; }, [onFocusCluster]);

  const nodesRef   = useRef<GNode[]>([]);
  const edgesRef   = useRef<Edge[]>([]);
  const centersRef = useRef<Record<string, CenterInfo>>({});
  const hovRef     = useRef<GNode | null>(null);
  const rafRef     = useRef<number>(0);
  const tickRef    = useRef(0);
  const [cursor, setCursor] = useState<"pointer" | "default" | "grabbing">("default");

  // ── View transform (pan/zoom) — ref-held, not React state (60fps loop) ────
  const viewRef = useRef<ViewTransform>({ k: 1, tx: 0, ty: 0 });
  const cameraAnimRef = useRef<CameraAnim | null>(null);

  // ── Drag/pan bookkeeping ────────────────────────────────────────────────
  const dragRef = useRef({
    active: false,
    moved: 0,
    lastX: 0,
    lastY: 0,
    downX: 0,
    downY: 0,
  });

  // ── Starfield (precomputed once per canvas build) ──────────────────────
  const starsRef = useRef<{ near: Star[]; mid: Star[]; far: Star[] }>({ near: [], mid: [], far: [] });
  const shootingStarsRef = useRef<ShootingStar[]>([]);
  const nextShootingStarAtRef = useRef(0);

  // ── Citation pulses + meteors (imperative API) ─────────────────────────
  const pulsesRef = useRef<CitationPulse[]>([]);
  const meteorsRef = useRef<Map<number, Meteor>>(new Map());

  // ── Build graph ─────────────────────────────────────────────────────────
  const buildGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !papers.length) {
      nodesRef.current = [];
      edgesRef.current = [];
      centersRef.current = {};
      starsRef.current = { near: [], mid: [], far: [] };
      return;
    }
    const W = canvas.width  || canvas.offsetWidth  || 0;
    const H = canvas.height || canvas.offsetHeight || 0;
    if (W < 10 || H < 10) return;

    // ── Build prefix tree from cluster_path strings ──────────────────────
    const prefixChildren: Record<string, string[]> = { __ROOT__: [] };
    const prefixDepth: Record<string, number>      = {};

    for (const p of papers) {
      const parts = (p.cluster_path ?? "Unclustered").split("/");
      for (let d = 0; d < parts.length; d++) {
        const prefix = parts.slice(0, d + 1).join("/");
        if (prefix in prefixDepth) continue;
        prefixDepth[prefix] = d;
        prefixChildren[prefix] = [];
        const parent = d === 0 ? "__ROOT__" : parts.slice(0, d).join("/");
        if (!prefixChildren[parent]) prefixChildren[parent] = [];
        prefixChildren[parent].push(prefix);
      }
    }

    // ── L1 color map ─────────────────────────────────────────────────────
    const l1ColorIdx: Record<string, number> = {};
    (prefixChildren["__ROOT__"] ?? []).forEach((l1, i) => {
      l1ColorIdx[l1] = i % PALETTE.length;
    });

    // ── Place centers recursively (nested solar-system layout) ────────────
    const { left, right, top, bottom } = insetsRef.current;
    const availW = Math.max(120, W - left - right);
    const availH = Math.max(120, H - top - bottom);
    const R0 = Math.min(availW, availH) * 0.3;
    const centers: Record<string, CenterInfo> = {};

    function placeCenters(
      parentKey: string,
      px: number,
      py: number,
      radius: number,
      depth: number,
    ) {
      const children = prefixChildren[parentKey] ?? [];
      children.forEach((prefix, i) => {
        const angle = (i / children.length) * Math.PI * 2 - Math.PI / 2;
        const cx = px + Math.cos(angle) * radius;
        const cy = py + Math.sin(angle) * radius;
        const l1 = prefix.split("/")[0];
        centers[prefix] = { x: cx, y: cy, depth, colorIdx: l1ColorIdx[l1] ?? 0 };
        placeCenters(prefix, cx, cy, radius * ORBIT_DECAY, depth + 1);
      });
    }

    placeCenters("__ROOT__", left + availW / 2, top + availH / 2, R0, 0);
    centersRef.current = centers;

    // ── Build nodes ───────────────────────────────────────────────────────
    const nodes: GNode[] = papers.map(p => {
      const l1 = p.cluster_path?.split("/")[0] ?? "Unclustered";
      const colorIdx = l1ColorIdx[l1] ?? 0;
      // Start near the deepest available center for each paper
      const home = centers[p.cluster_path ?? l1] ?? centers[l1] ?? { x: W / 2, y: H / 2 };
      return {
        id: p.id,
        x: home.x + jitter(p.id, 1),
        y: home.y + jitter(p.id, 2),
        vx: 0, vy: 0,
        paper: p, l1, colorIdx,
      };
    });

    // ── Build edges (depth-graded) ────────────────────────────────────────
    const edges: Edge[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const depth = sharedPathDepth(
          nodes[i].paper.cluster_path,
          nodes[j].paper.cluster_path,
        );
        if (depth >= 1) edges.push([i, j, depth]);
      }
    }

    nodesRef.current = nodes;
    edgesRef.current = edges;
    tickRef.current  = 0;
    hovRef.current   = null;

    // ── Starfield — precomputed once, seeded off canvas dims so it's stable
    // across rebuilds of the same size but varies with real dims. ─────────
    const mkLayer = (count: number, seedBase: number): Star[] => {
      const stars: Star[] = [];
      for (let i = 0; i < count; i++) {
        const sx = hash01(`star-${seedBase}-${i}`, 1) * W;
        const sy = hash01(`star-${seedBase}-${i}`, 2) * H;
        const r  = 0.6 + hash01(`star-${seedBase}-${i}`, 3) * 1.5;
        const phase = hash01(`star-${seedBase}-${i}`, 4) * Math.PI * 2;
        const twinkleSpeed = 0.4 + hash01(`star-${seedBase}-${i}`, 5) * 1.6;
        stars.push({ x: sx, y: sy, r, phase, twinkleSpeed });
      }
      return stars;
    };
    starsRef.current = {
      far:  mkLayer(280, 1),
      mid:  mkLayer(190, 3),
      near: mkLayer(130, 2),
    };
    shootingStarsRef.current = [];
    nextShootingStarAtRef.current = performance.now() + 1500 + Math.random() * 2500;
  }, [papers]);

  // ── Camera glide helper ──────────────────────────────────────────────────
  // Computes a ViewTransform that frames a cluster's member-node bounding box
  // (with padding) within the panel-safe viewport area, and kicks off a
  // rAF-driven ease-out animation toward it.
  const glideToClusterPath = useCallback((path: string | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.width || canvas.offsetWidth || 0;
    const H = canvas.height || canvas.offsetHeight || 0;
    if (W < 10 || H < 10) return;
    const { left, right, top, bottom } = insetsRef.current;
    const viewW = Math.max(120, W - left - right);
    const viewH = Math.max(120, H - top - bottom);

    let target: ViewTransform;
    if (path === null) {
      target = { k: 1, tx: 0, ty: 0 };
    } else {
      const nodes = nodesRef.current.filter(n =>
        n.paper.cluster_path === path || n.paper.cluster_path?.startsWith(path + "/"),
      );
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      if (nodes.length) {
        for (const n of nodes) {
          minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
          minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
        }
      } else {
        const c = centersRef.current[path];
        if (c) { minX = c.x - 100; maxX = c.x + 100; minY = c.y - 100; maxY = c.y + 100; }
        else { minX = 0; maxX = W; minY = 0; maxY = H; }
      }
      const pad = 80;
      const bw = Math.max(40, maxX - minX + pad * 2);
      const bh = Math.max(40, maxY - minY + pad * 2);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(viewW / bw, viewH / bh)));
      // screen = world*k + t  =>  want world center to map to viewport center
      const targetScreenX = left + viewW / 2;
      const targetScreenY = top + viewH / 2;
      target = {
        k,
        tx: targetScreenX - cx * k,
        ty: targetScreenY - cy * k,
      };
    }

    cameraAnimRef.current = {
      from: { ...viewRef.current },
      to: target,
      start: performance.now(),
      duration: CAMERA_ANIM_MS,
      onArrive: path ? () => onFocusClusterRef.current?.(path) : undefined,
    };
  }, []);

  // ── Canvas resize ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let rafId = 0;
    const sync = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (w > 10 && h > 10) {
        canvas.width  = w;
        canvas.height = h;
        buildGraph();
      } else {
        rafId = requestAnimationFrame(sync);
      }
    };
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    sync();
    return () => { ro.disconnect(); cancelAnimationFrame(rafId); };
  }, [active, buildGraph]);

  // ── Render loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const loop = () => {
      const now = performance.now();
      const W = canvas.width;
      const H = canvas.height;
      if (W < 10 || H < 10) { rafRef.current = requestAnimationFrame(loop); return; }

      const nodes   = nodesRef.current;
      const edges   = edgesRef.current;
      const centers = centersRef.current;
      const settled = tickRef.current >= SETTLE_AT;

      // ── Physics ────────────────────────────────────────────────────────
      if (!settled && nodes.length) {
        // Node–node repulsion
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[j].x - nodes[i].x;
            const dy = nodes[j].y - nodes[i].y;
            const d2 = dx * dx + dy * dy;
            const d  = Math.sqrt(d2) || 0.1;
            if (d < 200) {
              const f  = Math.min(REPULSION / (d2 + 1), MAX_FORCE);
              const nx = (dx / d) * f;
              const ny = (dy / d) * f;
              nodes[i].vx -= nx; nodes[i].vy -= ny;
              nodes[j].vx += nx; nodes[j].vy += ny;
            }
          }
        }

        // Multi-level centroid attraction
        for (const n of nodes) {
          const parts = (n.paper.cluster_path ?? n.l1).split("/");
          for (let d = 0; d < parts.length; d++) {
            const prefix = parts.slice(0, d + 1).join("/");
            const c = centers[prefix];
            if (!c) continue;
            // Deeper level = stronger pull (more specific cluster)
            const k = CENTER_K * (d + 1);
            n.vx += (c.x - n.x) * k;
            n.vy += (c.y - n.y) * k;
          }
        }

        // Integrate + bounce off the panel-safe area
        const { left, right, top, bottom } = insetsRef.current;
        for (const n of nodes) {
          n.vx *= DAMPING; n.vy *= DAMPING;
          const speed = Math.hypot(n.vx, n.vy);
          if (speed > MAX_SPEED) {
            n.vx *= MAX_SPEED / speed;
            n.vy *= MAX_SPEED / speed;
          }
          n.x  += n.vx;   n.y  += n.vy;
          if (n.x < left)       { n.x = left;       n.vx *= -0.3; }
          if (n.x > W - right)  { n.x = W - right;  n.vx *= -0.3; }
          if (n.y < top)        { n.y = top;        n.vy *= -0.3; }
          if (n.y > H - bottom) { n.y = H - bottom; n.vy *= -0.3; }
        }
        tickRef.current++;
      }

      // ── Camera animation (glide toward a focus target) ──────────────────
      const anim = cameraAnimRef.current;
      if (anim) {
        const t = easeOutCubic((now - anim.start) / anim.duration);
        viewRef.current = {
          k:  lerp(anim.from.k,  anim.to.k,  t),
          tx: lerp(anim.from.tx, anim.to.tx, t),
          ty: lerp(anim.from.ty, anim.to.ty, t),
        };
        if (t >= 1) {
          cameraAnimRef.current = null;
          anim.onArrive?.();
        }
      }

      const view = viewRef.current;

      // ── Clear ─────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, W, H);

      // Background dot grid (screen-space, not affected by pan/zoom — static reference)
      ctx.fillStyle = "rgba(29,37,55,0.55)";
      const GRID = 38;
      for (let gx = GRID / 2; gx < W; gx += GRID)
        for (let gy = GRID / 2; gy < H; gy += GRID) {
          ctx.beginPath();
          ctx.arc(gx, gy, 0.65, 0, Math.PI * 2);
          ctx.fill();
        }

      // ── Starfield — three parallax layers, drifting slowly + offset opposite
      // to pan so it feels like depth, each star twinkling on its own cycle.
      // Cheap: precomputed positions, just a per-frame sinusoidal wobble +
      // brightness pulse + a parallax offset from view.tx/ty. ────────────────
      const drawStars = (stars: Star[], parallax: number, alpha: number, driftSpeed: number) => {
        const px = view.tx * parallax;
        const py = view.ty * parallax;
        for (const s of stars) {
          const dx = Math.sin(now / 4000 * driftSpeed + s.phase) * 3;
          const dy = Math.cos(now / 5000 * driftSpeed + s.phase) * 3;
          const x = s.x + px + dx;
          const y = s.y + py + dy;
          const twinkle = 0.5 + 0.5 * Math.sin(now / 1000 * s.twinkleSpeed + s.phase * 2);
          ctx.fillStyle = `rgba(210,225,255,${alpha * (0.4 + 0.6 * twinkle)})`;
          ctx.beginPath();
          ctx.arc(x, y, s.r * (0.8 + 0.4 * twinkle), 0, Math.PI * 2);
          ctx.fill();
        }
      };
      drawStars(starsRef.current.far,  0.04, 0.35, 0.6);
      drawStars(starsRef.current.mid,  0.065, 0.5, 0.8);
      drawStars(starsRef.current.near, 0.09, 0.7, 1.0);

      // ── Shooting stars — streaks across the field for extra motion. ────────
      if (now >= nextShootingStarAtRef.current) {
        const ang = Math.PI * 0.15 + Math.random() * Math.PI * 0.1; // shallow diagonal
        const len = Math.max(W, H) * (0.5 + Math.random() * 0.4);
        const x0 = Math.random() * W * 0.6;
        const y0 = Math.random() * H * 0.3;
        shootingStarsRef.current.push({
          id: meteorIdSeq++,
          x0, y0,
          x1: x0 + Math.cos(ang) * len,
          y1: y0 + Math.sin(ang) * len,
          start: now,
          duration: 700 + Math.random() * 400,
        });
        nextShootingStarAtRef.current = now + 1800 + Math.random() * 3200;
      }
      if (shootingStarsRef.current.length) {
        shootingStarsRef.current = shootingStarsRef.current.filter(ss => now - ss.start < ss.duration);
        for (const ss of shootingStarsRef.current) {
          const t = (now - ss.start) / ss.duration;
          const head = Math.min(1, t * 1.4);
          const tail = Math.max(0, head - 0.35);
          const hx = lerp(ss.x0, ss.x1, head);
          const hy = lerp(ss.y0, ss.y1, head);
          const tx = lerp(ss.x0, ss.x1, tail);
          const ty = lerp(ss.y0, ss.y1, tail);
          const fade = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
          const grad = ctx.createLinearGradient(tx, ty, hx, hy);
          grad.addColorStop(0, "rgba(210,225,255,0)");
          grad.addColorStop(1, `rgba(230,240,255,${0.85 * fade})`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hx, hy);
          ctx.stroke();
        }
      }

      if (!nodes.length) {
        // Empty state is rendered by the parent overlay
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      // ── World-space drawing under pan/zoom transform ────────────────────
      ctx.save();
      ctx.translate(view.tx, view.ty);
      ctx.scale(view.k, view.k);

      const hov = hovRef.current;
      const simGraph = similarityRef.current;
      const hasSimHighlight = !!(hov && simGraph && simGraph[hov.id]?.length);
      const simNeighborIds = new Set<string>();
      if (hasSimHighlight && hov) {
        for (const nb of simGraph![hov.id]) simNeighborIds.add(nb.id);
      }
      const dimFactor = hasSimHighlight ? 0.18 : 1;

      // ── Cluster auras (L1 large, L2 smaller, deeper = skip) ───────────
      // Ghost label alpha fades in/out with k: most visible around k≈1,
      // fades toward 0 both zoomed way out and zoomed in close.
      const labelFade = triangleFade(view.k, 0.35, 1.0, 2.2);
      for (const [prefix, c] of Object.entries(centers)) {
        if (c.depth > 1) continue;           // only L1 + L2 auras
        const col    = PALETTE[c.colorIdx % PALETTE.length];
        const auraR  = c.depth === 0 ? 160 : 80;
        const baseA  = (c.depth === 0 ? 0.055 : 0.032) * dimFactor;
        const grd    = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, auraR);
        grd.addColorStop(0, col.glow + baseA + ")");
        grd.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(c.x, c.y, auraR, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        // Ghost label — L1 only, LOD-faded by zoom level
        if (c.depth === 0 && labelFade > 0.001) {
          ctx.save();
          ctx.globalAlpha = 0.055 * labelFade * dimFactor;
          ctx.fillStyle   = col.stroke;
          ctx.font        = "bold 30px Inter, system-ui, sans-serif";
          ctx.textAlign   = "center";
          ctx.textBaseline = "middle";
          const words  = prefix.split("/").pop()!.split(" ");
          const lines: string[] = [];
          for (let i = 0; i < words.length; i += 2) lines.push(words.slice(i, i + 2).join(" "));
          const lh     = 34;
          const startY = c.y - ((lines.length - 1) * lh) / 2;
          lines.forEach((line, li) => ctx.fillText(line, c.x, startY + li * lh));
          ctx.restore();
        }
      }

      // ── Edges (depth-graded opacity + distance decay) ──────────────────
      for (const [ai, bi, depth] of edges) {
        const a   = nodes[ai];
        const b   = nodes[bi];
        const col = PALETTE[a.colorIdx % PALETTE.length];
        const dx  = b.x - a.x;
        const dy  = b.y - a.y;
        const d   = Math.sqrt(dx * dx + dy * dy);
        // Deeper shared ancestry → stronger max alpha; farther apart → fade out
        const maxA   = edgeMaxAlpha(depth);
        let alpha  = Math.max(0, maxA - d / 1000);
        if (hasSimHighlight) alpha *= dimFactor;
        if (alpha < 0.005) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = col.glow + alpha.toFixed(3) + ")";
        ctx.lineWidth   = depth >= 3 ? 1.5 : 1;
        ctx.stroke();
      }

      // ── Constellation edges — real embedding-similarity neighbors ───────
      if (hasSimHighlight && hov) {
        const neighbors = simGraph![hov.id];
        const idToNode = new Map(nodes.map(n => [n.id, n]));
        for (const nb of neighbors) {
          const target = idToNode.get(nb.id);
          if (!target) continue;
          const mx = (hov.x + target.x) / 2;
          const my = (hov.y + target.y) / 2;
          ctx.beginPath();
          ctx.moveTo(hov.x, hov.y);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = `rgba(255,255,255,${0.55 + nb.score * 0.35})`;
          ctx.lineWidth = 2.25;
          ctx.shadowColor = "rgba(255,255,255,0.8)";
          ctx.shadowBlur = 8;
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Percentage label near midpoint
          const pct = Math.round(nb.score * 100);
          ctx.save();
          ctx.font = "600 11px Inter, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.fillText(`${pct}%`, mx, my - 6);
          ctx.restore();
        }
      }

      // ── Idle drift ("breathing") — settled nodes get a tiny render-only
      // sinusoidal wobble, derived deterministically from id so it's stable
      // across reloads. Does not feed back into n.x/n.y or velocity. ──────
      const idleT = now / 1000;

      // ── Node LOD label thresholds ────────────────────────────────────────
      const titleFade  = rampFade(view.k, 1.8, 2.3);
      const metaFade   = rampFade(view.k, 3.0, 3.6);
      // Visible world-space bounds for cheap culling of label text draws
      const viewMinX = -view.tx / view.k;
      const viewMinY = -view.ty / view.k;
      const viewMaxX = (W - view.tx) / view.k;
      const viewMaxY = (H - view.ty) / view.k;

      // ── Nodes ─────────────────────────────────────────────────────────
      for (const n of nodes) {
        const isHov = hov?.id === n.id;
        const isSimNeighbor = hasSimHighlight && simNeighborIds.has(n.id);
        const nodeDim = hasSimHighlight && !isHov && !isSimNeighbor ? dimFactor : 1;
        const col   = PALETTE[n.colorIdx % PALETTE.length];
        const r     = isHov ? NODE_R + 4 : NODE_R;

        let renderX = n.x;
        let renderY = n.y;
        if (settled) {
          const freq = 0.15 + hash01(n.id, 11) * 0.1; // ~4-8s period range
          const ampX = 2 + hash01(n.id, 12) * 2;
          const ampY = 2 + hash01(n.id, 13) * 2;
          const phaseX = hash01(n.id, 14) * Math.PI * 2;
          const phaseY = hash01(n.id, 15) * Math.PI * 2;
          renderX = n.x + Math.sin(idleT * freq + phaseX) * ampX;
          renderY = n.y + Math.cos(idleT * freq + phaseY) * ampY;
        }

        // Glow halo
        const glowR = r * (isHov ? 5.5 : 3.5);
        const grd   = ctx.createRadialGradient(renderX, renderY, r * 0.1, renderX, renderY, glowR);
        grd.addColorStop(0, col.glow + ((isHov ? 0.55 : 0.3) * nodeDim).toFixed(3) + ")");
        grd.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(renderX, renderY, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        // Fill
        ctx.beginPath();
        ctx.arc(renderX, renderY, r, 0, Math.PI * 2);
        ctx.fillStyle = col.glow + ((isHov ? 0.25 : 0.1) * nodeDim).toFixed(3) + ")";
        ctx.fill();

        // Ring
        ctx.beginPath();
        ctx.arc(renderX, renderY, r, 0, Math.PI * 2);
        ctx.globalAlpha = nodeDim;
        ctx.strokeStyle = col.stroke + (isHov ? "ff" : "bb");
        ctx.lineWidth   = isHov ? 2 : 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Core dot
        ctx.beginPath();
        ctx.arc(renderX, renderY, r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = col.dot;
        ctx.globalAlpha = nodeDim;
        ctx.fill();
        ctx.globalAlpha = 1;

        // ── LOD text labels (title, then author/year) — culled to visible
        // world-space bounds, faded in over a k-range. ────────────────────
        if (titleFade > 0.001) {
          if (renderX >= viewMinX - 40 && renderX <= viewMaxX + 40 &&
              renderY >= viewMinY - 20 && renderY <= viewMaxY + 40) {
            const rawTitle = n.paper.title || n.paper.filename.replace(/\.pdf$/i, "");
            const title = rawTitle.length > 36 ? rawTitle.slice(0, 33) + "…" : rawTitle;
            ctx.save();
            ctx.globalAlpha = titleFade * nodeDim;
            ctx.font = "500 11px Inter, system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillStyle = "rgba(226,232,240,0.92)";
            ctx.fillText(title, renderX + r + 6, renderY + r + 2);

            if (metaFade > 0.001) {
              const author = n.paper.author ?? "";
              const year = n.paper.year ?? "";
              const meta = [author, year].filter(Boolean).join(" · ");
              if (meta) {
                ctx.globalAlpha = titleFade * metaFade * nodeDim;
                ctx.font = "400 10px Inter, system-ui, sans-serif";
                ctx.fillStyle = "rgba(148,163,184,0.85)";
                ctx.fillText(meta, renderX + r + 6, renderY + r + 15);
              }
            }
            ctx.restore();
          }
        }
      }

      // ── Citation pulses — traveling light + fading comet tail ───────────
      if (pulsesRef.current.length) {
        const remaining: CitationPulse[] = [];
        for (const p of pulsesRef.current) {
          const t = (now - p.start) / p.duration;
          if (t >= 1) continue;
          const e = easeOutCubic(t);
          const px = lerp(p.fromX, p.toX, e);
          const py = lerp(p.fromY, p.toY, e);
          // Comet tail: a few trailing samples behind current position
          for (let ti = 1; ti <= 5; ti++) {
            const tt = Math.max(0, t - ti * 0.03);
            const te = easeOutCubic(tt);
            const tx = lerp(p.fromX, p.toX, te);
            const ty = lerp(p.fromY, p.toY, te);
            const a = (1 - ti / 5) * 0.5 * (1 - t);
            ctx.beginPath();
            ctx.arc(tx, ty, 2.4 - ti * 0.3, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
            ctx.fill();
          }
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${(1 - t * 0.3).toFixed(3)})`;
          ctx.shadowColor = "rgba(255,255,255,0.9)";
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
          remaining.push(p);
        }
        pulsesRef.current = remaining;
      }

      // ── Meteors — in-flight uploads drifting toward center, or gliding to
      // a resolved cluster center with a landing ripple. ──────────────────
      if (meteorsRef.current.size) {
        const toRemove: number[] = [];
        for (const [id, m] of meteorsRef.current) {
          if (m.canceled) {
            const t = (now - m.cancelStart) / 400;
            if (t >= 1) { toRemove.push(id); continue; }
            drawMeteorGlyph(ctx, m.x, m.y, 1 - t);
            continue;
          }
          if (m.landed) {
            const t = (now - m.landedAt) / 700;
            if (t >= 1) { toRemove.push(id); continue; }
            // Ripple/flash
            const rippleR = lerp(4, 60, easeOutCubic(t));
            const rippleA = (1 - t) * 0.8;
            ctx.beginPath();
            ctx.arc(m.x, m.y, rippleR, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255,255,255,${rippleA.toFixed(3)})`;
            ctx.lineWidth = 2;
            ctx.stroke();
            const grd = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, rippleR * 0.6);
            grd.addColorStop(0, `rgba(255,255,255,${(rippleA * 0.6).toFixed(3)})`);
            grd.addColorStop(1, "transparent");
            ctx.beginPath();
            ctx.arc(m.x, m.y, rippleR * 0.6, 0, Math.PI * 2);
            ctx.fillStyle = grd;
            ctx.fill();
            continue;
          }
          if (m.arriving && m.arriveFrom && m.arriveTo) {
            const t = (now - m.arriveStart) / m.arriveDuration;
            if (t >= 1) {
              m.x = m.arriveTo.x; m.y = m.arriveTo.y;
              m.landed = true; m.landedAt = now;
              drawMeteorGlyph(ctx, m.x, m.y, 1);
              continue;
            }
            const e = easeOutCubic(t);
            m.x = lerp(m.arriveFrom.x, m.arriveTo.x, e);
            m.y = lerp(m.arriveFrom.y, m.arriveTo.y, e);
            drawMeteorGlyph(ctx, m.x, m.y, 1);
            continue;
          }
          // Idle drift toward center with wobble (screen space; cluster unknown yet)
          const dt = (now - m.createdAt) / 1000;
          const driftT = Math.min(1, dt / 3); // settle near center over ~3s, then hover
          const baseX = lerp(m.edgeX, m.centerX, driftT);
          const baseY = lerp(m.edgeY, m.centerY, driftT);
          m.x = baseX + Math.sin(dt * 0.8 + m.driftPhaseX) * 12;
          m.y = baseY + Math.cos(dt * 0.7 + m.driftPhaseY) * 12;
          drawMeteorGlyph(ctx, m.x, m.y, 1);
        }
        for (const id of toRemove) meteorsRef.current.delete(id);
      }

      ctx.restore();

      // Detail on hover is surfaced by the floating HoverBar (App.tsx), not the canvas —
      // avoids showing the same title/author/status twice at once.

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  // ── Screen <-> world coordinate helpers ──────────────────────────────────
  const toWorld = useCallback((mx: number, my: number) => {
    const { k, tx, ty } = viewRef.current;
    return { x: (mx - tx) / k, y: (my - ty) / k };
  }, []);

  // ── Mouse events ─────────────────────────────────────────────────────────
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const drag = dragRef.current;
    if (drag.active) {
      const dx = mx - drag.lastX;
      const dy = my - drag.lastY;
      drag.moved = Math.hypot(mx - drag.downX, my - drag.downY);
      drag.lastX = mx;
      drag.lastY = my;
      if (drag.moved > DRAG_THRESHOLD) {
        viewRef.current = {
          k: viewRef.current.k,
          tx: viewRef.current.tx + dx,
          ty: viewRef.current.ty + dy,
        };
        setCursor("grabbing");
      }
      return;
    }

    const world = toWorld(mx, my);
    let closest: GNode | null = null;
    let minD = 26 / viewRef.current.k;
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - world.x, n.y - world.y);
      if (d < minD) { minD = d; closest = n; }
    }
    if (closest?.id !== hovRef.current?.id) {
      hovRef.current = closest;
      setCursor(closest ? "pointer" : "default");
      onHover?.(closest?.paper ?? null);
    }
  }, [onHover, toWorld]);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    dragRef.current = { active: true, moved: 0, lastX: mx, lastY: my, downX: mx, downY: my };
  }, []);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const wasDrag = drag.active && drag.moved > DRAG_THRESHOLD;
    drag.active = false;
    setCursor(hovRef.current ? "pointer" : "default");
    if (wasDrag) return;

    // Treat as click: either open the hovered paper, or hit-test a cluster
    // aura/label to trigger a camera glide.
    const p = hovRef.current?.paper;
    if (p) { onOpenPaper?.(p); return; }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = toWorld(mx, my);
    for (const [path, c] of Object.entries(centersRef.current)) {
      if (c.depth > 1) continue;
      const auraR = c.depth === 0 ? 160 : 80;
      if (Math.hypot(c.x - world.x, c.y - world.y) <= auraR) {
        glideToClusterPath(path);
        return;
      }
    }
  }, [onOpenPaper, toWorld, glideToClusterPath]);

  const onMouseLeave = useCallback(() => {
    dragRef.current.active = false;
    hovRef.current = null;
    setCursor("default");
    onHover?.(null);
  }, [onHover]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { k, tx, ty } = viewRef.current;
    const zoomFactor = Math.exp(-e.deltaY * 0.0015);
    const newK = Math.min(MAX_K, Math.max(MIN_K, k * zoomFactor));
    // Zoom toward cursor: keep world point under cursor fixed on screen
    const worldX = (mx - tx) / k;
    const worldY = (my - ty) / k;
    cameraAnimRef.current = null; // wheel interrupts any in-flight glide
    viewRef.current = {
      k: newK,
      tx: mx - worldX * newK,
      ty: my - worldY * newK,
    };
  }, []);

  const onDoubleClick = useCallback(() => {
    if (hovRef.current) return; // double-click on a node shouldn't reset view
    glideToClusterPath(null);
  }, [glideToClusterPath]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "0") {
        glideToClusterPath(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [glideToClusterPath]);

  // ── Imperative handle ────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    pulseCitations(paperIds: string[]) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const W = canvas.width || canvas.offsetWidth || 0;
      const H = canvas.height || canvas.offsetHeight || 0;
      const target = pulseTargetRef.current ?? { x: W / 2, y: H - 40 };
      const { k, tx, ty } = viewRef.current;
      const idToNode = new Map(nodesRef.current.map(n => [n.id, n]));
      const now = performance.now();
      for (const id of paperIds) {
        const n = idToNode.get(id);
        if (!n) continue;
        // Node world coords -> screen space (pulses render in world space via
        // the same transform as everything else, so convert target to world)
        const targetWorldX = (target.x - tx) / k;
        const targetWorldY = (target.y - ty) / k;
        pulsesRef.current.push({
          id: pulseIdSeq++,
          fromX: n.x, fromY: n.y,
          toX: targetWorldX, toY: targetWorldY,
          start: now,
          duration: 900 + Math.random() * 300,
        });
      }
    },
    spawnMeteor() {
      const canvas = canvasRef.current;
      const W = canvas?.width || canvas?.offsetWidth || 800;
      const H = canvas?.height || canvas?.offsetHeight || 600;
      const { k, tx, ty } = viewRef.current;
      const id = meteorIdSeq++;

      // Pick a random screen edge, convert to world space for the drift path.
      const edgeSide = Math.floor(Math.random() * 4);
      let ex: number, ey: number;
      if (edgeSide === 0) { ex = -20; ey = Math.random() * H; }
      else if (edgeSide === 1) { ex = W + 20; ey = Math.random() * H; }
      else if (edgeSide === 2) { ex = Math.random() * W; ey = -20; }
      else { ex = Math.random() * W; ey = H + 20; }
      const edgeWorldX = (ex - tx) / k;
      const edgeWorldY = (ey - ty) / k;
      const centerWorldX = (W / 2 - tx) / k;
      const centerWorldY = (H / 2 - ty) / k;

      const meteor: Meteor = {
        id,
        x: edgeWorldX, y: edgeWorldY,
        driftPhaseX: Math.random() * Math.PI * 2,
        driftPhaseY: Math.random() * Math.PI * 2,
        edgeX: edgeWorldX, edgeY: edgeWorldY,
        centerX: centerWorldX, centerY: centerWorldY,
        arriving: false, arriveFrom: null, arriveTo: null,
        arriveStart: 0, arriveDuration: 750,
        landed: false, landedAt: 0,
        canceled: false, cancelStart: 0,
        createdAt: performance.now(),
      };
      meteorsRef.current.set(id, meteor);

      return {
        arrive: (clusterPath: string) => {
          const m = meteorsRef.current.get(id);
          if (!m) return;
          const c = centersRef.current[clusterPath];
          let toX: number, toY: number;
          if (c) { toX = c.x; toY = c.y; }
          else {
            // Fall back to overall graph center if the cluster isn't in the
            // current data yet (e.g. brand-new cluster not reflected in papers).
            const canvas2 = canvasRef.current;
            const W2 = canvas2?.width || canvas2?.offsetWidth || 800;
            const H2 = canvas2?.height || canvas2?.offsetHeight || 600;
            const { left, right, top, bottom } = insetsRef.current;
            toX = left + (W2 - left - right) / 2;
            toY = top + (H2 - top - bottom) / 2;
          }
          m.arriving = true;
          m.arriveFrom = { x: m.x, y: m.y };
          m.arriveTo = { x: toX, y: toY };
          m.arriveStart = performance.now();
        },
        cancel: () => {
          const m = meteorsRef.current.get(id);
          if (!m) return;
          m.canceled = true;
          m.cancelStart = performance.now();
        },
      };
    },
    focusCluster(path: string | null) {
      glideToClusterPath(path);
    },
  }), [glideToClusterPath]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full block"
      style={{ cursor }}
      onMouseMove={onMouseMove}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
    />
  );
});

// Small comet-like glyph used for in-flight/arriving meteors: a bright core
// with a soft radial glow, drawn in the current (world-space transformed)
// context. `alpha` is an overall multiplier used for fade-out on cancel.
function drawMeteorGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number) {
  const glowR = 22;
  const grd = ctx.createRadialGradient(x, y, 0, x, y, glowR);
  grd.addColorStop(0, `rgba(255,255,255,${(0.55 * alpha).toFixed(3)})`);
  grd.addColorStop(1, "transparent");
  ctx.beginPath();
  ctx.arc(x, y, glowR, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${(0.95 * alpha).toFixed(3)})`;
  ctx.shadowColor = "rgba(255,255,255,0.9)";
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;
}
