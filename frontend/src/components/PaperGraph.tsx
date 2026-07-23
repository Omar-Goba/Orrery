import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PaperRecord } from "../api/client";
import type { SimilarityGraph } from "../api/client";
import { StarfieldCanvas } from "./StarfieldCanvas";
import { cometStrength } from "../lib/galaxy";
import {
  buildConstellationEdges,
  constellationMembershipSignature,
  type ConstellationEdge,
} from "../lib/constellation";
import {
  createGalaxyPhysicsConfig,
  createGalaxyPhysicsState,
  precomputeAmbientMotion,
  precomputeHierarchyAnchors,
  recoverGalaxyAfterDrag,
  stepGalaxyPhysics,
  type GalaxyAnchor,
  type GalaxyAmbientMotion,
  type GalaxyDragConstraint,
} from "../lib/galaxyPhysics";
import { getPhaseEnvelope, type IngestProgress } from "../lib/ingestMotion";
import {
  ellipsizeLabel,
  placeSemanticLabels,
  type LabelCandidate,
  type LabelRect,
} from "../lib/semanticLabels";
import {
  cancelIngestOrb,
  createIngestOrbState,
  ingestOrbOpacity,
  resolveIngestOrb,
  shouldRemoveIngestOrb,
  stepIngestOrb,
  suppressedPaperId,
  updateIngestOrb,
  type IngestOrbState,
} from "../lib/ingestOrbController";

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
  anchors: readonly GalaxyAnchor[];
  ambient: GalaxyAmbientMotion;
  drag: GalaxyDragConstraint | null;
  recovery: number;
  /** 1 = ingested right now, fading to 0 at 7 days old. Precomputed per build. */
  comet: number;
}

interface CenterInfo {
  x: number;
  y: number;
  depth: number;
  colorIdx: number;
}

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

interface CitationPulse {
  id: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
}

export interface IngestOrbHandle {
  update(progress: IngestProgress): void;
  resolve(paper: PaperRecord): void;
  cancel(): void;
}

export interface PaperGraphHandle {
  pulseCitations(paperIds: string[]): void;
  spawnIngestOrb(seed: string): IngestOrbHandle;
  focusCluster(path: string | null): void; // null = zoom-to-fit / reset view
  /** One-shot flare when a paper flips toread→read. De-ignition gets no animation. */
  igniteStar(paperId: string): void;
}

interface Ignition {
  x: number;
  y: number;
  start: number;
}

// ── Color palette ───────────────────────────────────────────────────────────
const PALETTE = [
  { stroke: "#22d3ee", glow: "rgba(34,211,238,",  dot: "rgba(34,211,238,0.8)"  },
  { stroke: "#a78bfa", glow: "rgba(167,139,250,", dot: "rgba(167,139,250,0.8)" },
  { stroke: "#34d399", glow: "rgba(52,211,153,",  dot: "rgba(52,211,153,0.8)"  },
  { stroke: "#f59e0b", glow: "rgba(245,158,11,",  dot: "rgba(245,158,11,0.8)"  },
];

// Rogue stars (Misc/Unclustered papers) get a desaturated gray, never a hue —
// they drift untethered and are excluded from constellation edges.
const ROGUE_COLOR = { stroke: "#8b94a8", glow: "rgba(139,148,168,", dot: "rgba(139,148,168,0.8)" };

// ── Physics ─────────────────────────────────────────────────────────────────
const NODE_R     = 6;
const ORBIT_DECAY = 0.50;   // each depth level's orbit radius = parent's × this
const INITIAL_TOPOLOGY_WARMUP_SECONDS = 1;
const REDUCED_MOTION_WARMUP_SECONDS = 1.25;
const RELEASE_SPEED = 12;
const RELEASE_VELOCITY_WINDOW_MS = 80;
const PHYSICS_CONFIG = createGalaxyPhysicsConfig();
const WARMUP_PHYSICS_CONFIG = createGalaxyPhysicsConfig({
  repulsionStrength: PHYSICS_CONFIG.repulsionStrength * 1.5,
  ambientAcceleration: PHYSICS_CONFIG.ambientAcceleration * 1.25,
});

// ── View transform constants ────────────────────────────────────────────────
const MIN_K = 0.4;
const MAX_K = 6;
const DRAG_THRESHOLD = 4; // px — below this, pointer-down→pointer-up remains a click
const CAMERA_ANIM_MS = 600;

function jitter(id: string, axis: number): number {
  let hash = axis;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(31, hash) + id.charCodeAt(i);
  }
  return ((hash >>> 0) / 0xffffffff - 0.5) * 80;
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

let ingestOrbIdSeq = 1;
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
  /** Arrival dolly: start zoomed out at this k and glide to k=1 on first build. */
  initialView?: { k: number };
  /** Cluster path to keep fully visible in the leaf-label pass (autopilot tour). */
  highlightPath?: string | null;
  /** Paper whose label must remain visible after it is pinned outside the canvas. */
  selectedPaperId?: string | null;
}>(function PaperGraph({
  papers,
  onHover,
  onOpenPaper,
  active = true,
  insets,
  similarity,
  pulseTarget,
  onFocusCluster,
  initialView,
  highlightPath,
  selectedPaperId,
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

  const initialViewRef = useRef(initialView);
  useEffect(() => { initialViewRef.current = initialView; }, [initialView]);
  const didInitialDollyRef = useRef(false);

  const highlightPathRef = useRef(highlightPath);
  useEffect(() => { highlightPathRef.current = highlightPath; }, [highlightPath]);

  const selectedPaperIdRef = useRef(selectedPaperId);
  useEffect(() => { selectedPaperIdRef.current = selectedPaperId; }, [selectedPaperId]);

  const nodesRef   = useRef<GNode[]>([]);
  const nodesByIdRef = useRef<Map<string, GNode>>(new Map());
  const constellationEdgesRef = useRef<ConstellationEdge[]>([]);
  const constellationSignatureRef = useRef("");
  const topologyPendingRef = useRef(false);
  const topologyBuildAtRef = useRef(0);
  const leafCentersRef = useRef<Record<string, { x: number; y: number; count: number; colorIdx: number }>>({});
  const lastLeafCenterUpdateRef = useRef(0);
  const centersRef = useRef<Record<string, CenterInfo>>({});
  const hovRef     = useRef<GNode | null>(null);
  const labelAnchorsRef = useRef<Map<string, number>>(new Map());
  const rafRef     = useRef<number>(0);
  const physicsRef = useRef(createGalaxyPhysicsState());
  const lastFrameRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(
    typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
  );
  const reducedWarmupRemainingRef = useRef(
    reducedMotionRef.current ? REDUCED_MOTION_WARMUP_SECONDS : 0,
  );
  const [cursor, setCursor] = useState<"pointer" | "default" | "grabbing">("default");

  // ── View transform (pan/zoom) — ref-held, not React state (60fps loop) ────
  const viewRef = useRef<ViewTransform>({ k: 1, tx: 0, ty: 0 });
  const cameraAnimRef = useRef<CameraAnim | null>(null);

  // ── Drag/pan bookkeeping ────────────────────────────────────────────────
  const dragRef = useRef<{
    mode: "none" | "pan" | "node";
    pointerId: number;
    node: GNode | null;
    moved: number;
    lastX: number;
    lastY: number;
    downX: number;
    downY: number;
    lastWorldX: number;
    lastWorldY: number;
    lastMoveAt: number;
    releaseVx: number;
    releaseVy: number;
  }>({
    mode: "none", pointerId: -1, node: null, moved: 0,
    lastX: 0, lastY: 0, downX: 0, downY: 0,
    lastWorldX: 0, lastWorldY: 0, lastMoveAt: 0, releaseVx: 0, releaseVy: 0,
  });

  // ── Citation pulses + ingest orbs (imperative API) ─────────────────────
  const pulsesRef = useRef<CitationPulse[]>([]);
  const ingestOrbsRef = useRef<Map<number, IngestOrbState>>(new Map());
  const orbPointerRef = useRef<{ x: number; y: number } | null>(null);
  const ignitionsRef = useRef<Ignition[]>([]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => {
      const now = performance.now();
      for (const orb of ingestOrbsRef.current.values()) cancelIngestOrb(orb, now);
      reducedMotionRef.current = event.matches;
      reducedWarmupRemainingRef.current = 0;
      for (const node of nodesRef.current) {
        node.vx = 0;
        node.vy = 0;
        node.recovery = 0;
      }
      lastFrameRef.current = null;
    };
    reducedMotionRef.current = query.matches;
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => () => {
    ingestOrbsRef.current.clear();
    orbPointerRef.current = null;
  }, []);

  // ── Build graph ─────────────────────────────────────────────────────────
  const buildGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !papers.length) {
      nodesRef.current = [];
      nodesByIdRef.current = new Map();
      constellationEdgesRef.current = [];
      constellationSignatureRef.current = "";
      topologyPendingRef.current = false;
      leafCentersRef.current = {};
      centersRef.current = {};
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

    // ── Reconcile nodes by paper ID ───────────────────────────────────────
    const previousById = nodesByIdRef.current;
    const hadNodes = previousById.size > 0;
    let addedNode = false;
    const nodes: GNode[] = papers.map(p => {
      const l1 = p.cluster_path?.split("/")[0] ?? "Unclustered";
      const colorIdx = l1ColorIdx[l1] ?? 0;
      const path = p.cluster_path ?? "Unclustered";
      const anchors = precomputeHierarchyAnchors(path, centers);
      const existing = previousById.get(p.id);
      if (existing) {
        existing.paper = p;
        existing.l1 = l1;
        existing.colorIdx = colorIdx;
        existing.comet = cometStrength(p.ingested_at);
        existing.anchors = anchors;
        return existing;
      }

      addedNode = true;
      // Only genuinely new papers spawn near their deepest available center.
      const home = centers[p.cluster_path ?? l1] ?? centers[l1] ?? { x: W / 2, y: H / 2 };
      return {
        id: p.id,
        x: home.x + jitter(p.id, 1),
        y: home.y + jitter(p.id, 2),
        vx: 0, vy: 0,
        paper: p, l1, colorIdx,
        comet: cometStrength(p.ingested_at),
        anchors,
        ambient: precomputeAmbientMotion(p.id),
        drag: null,
        recovery: 0,
      };
    });

    nodesRef.current = nodes;
    nodesByIdRef.current = new Map(nodes.map(node => [node.id, node]));
    if (hovRef.current) hovRef.current = nodesByIdRef.current.get(hovRef.current.id) ?? null;

    const membership = nodes.map(node => ({
      id: node.id,
      x: node.x,
      y: node.y,
      leaf: node.paper.cluster_path ?? "Unclustered",
    }));
    const signature = constellationMembershipSignature(membership);
    if (signature !== constellationSignatureRef.current) {
      constellationSignatureRef.current = signature;
      constellationEdgesRef.current = [];
      topologyPendingRef.current = true;
      topologyBuildAtRef.current = physicsRef.current.elapsed
        + (hadNodes ? 0 : INITIAL_TOPOLOGY_WARMUP_SECONDS);
    }
    if (reducedMotionRef.current && addedNode) {
      reducedWarmupRemainingRef.current = REDUCED_MOTION_WARMUP_SECONDS;
    }
    lastFrameRef.current = null;

    if (!didInitialDollyRef.current && initialViewRef.current) {
      didInitialDollyRef.current = true;
      viewRef.current = { k: initialViewRef.current.k, tx: 0, ty: 0 };
      cameraAnimRef.current = {
        from: { ...viewRef.current },
        to: { k: 1, tx: 0, ty: 0 },
        start: performance.now(),
        duration: 600,
      };
    }
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
      if (document.visibilityState !== "visible") {
        lastFrameRef.current = null;
        return;
      }
      const now = performance.now();
      const W = canvas.width;
      const H = canvas.height;
      if (W < 10 || H < 10) { rafRef.current = requestAnimationFrame(loop); return; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      const nodes   = nodesRef.current;
      const centers = centersRef.current;

      // ── Physics ────────────────────────────────────────────────────────
      const previousFrame = lastFrameRef.current;
      const dt = previousFrame === null ? 0 : (now - previousFrame) / 1000;
      lastFrameRef.current = now;
      const reducedMotion = reducedMotionRef.current;
      const shouldSimulate = !reducedMotion || reducedWarmupRemainingRef.current > 0;
      if (shouldSimulate && nodes.length && dt > 0) {
        const { left, right, top, bottom } = insetsRef.current;
        stepGalaxyPhysics(
          physicsRef.current,
          nodes,
          { minX: left, maxX: W - right, minY: top, maxY: H - bottom },
          dt,
          physicsRef.current.elapsed < INITIAL_TOPOLOGY_WARMUP_SECONDS
            ? WARMUP_PHYSICS_CONFIG
            : PHYSICS_CONFIG,
        );
        if (reducedMotion) {
          reducedWarmupRemainingRef.current = Math.max(0, reducedWarmupRemainingRef.current - Math.min(dt, PHYSICS_CONFIG.maxDt));
          if (reducedWarmupRemainingRef.current === 0) {
            for (const node of nodes) { node.vx = 0; node.vy = 0; }
          }
        }
      }

      if (topologyPendingRef.current &&
          physicsRef.current.elapsed >= topologyBuildAtRef.current) {
        constellationEdgesRef.current = buildConstellationEdges(
          nodes.map(node => ({
            id: node.id,
            x: node.x,
            y: node.y,
            leaf: node.paper.cluster_path ?? "Unclustered",
          })),
        );
        topologyPendingRef.current = false;
      }

      // Labels follow moving members without creating per-frame React state.
      if (now - lastLeafCenterUpdateRef.current >= 200) {
        lastLeafCenterUpdateRef.current = now;
        const leafAgg: Record<string, { sx: number; sy: number; count: number; colorIdx: number }> = {};
        for (const node of nodes) {
          const leaf = node.paper.cluster_path ?? "Unclustered";
          if (leaf === "Misc" || leaf === "Unclustered") continue;
          const agg = leafAgg[leaf] ?? (leafAgg[leaf] = { sx: 0, sy: 0, count: 0, colorIdx: node.colorIdx });
          agg.sx += node.x; agg.sy += node.y; agg.count++;
        }
        const leafCenters: typeof leafCentersRef.current = {};
        for (const [leaf, agg] of Object.entries(leafAgg)) {
          leafCenters[leaf] = { x: agg.sx / agg.count, y: agg.sy / agg.count, count: agg.count, colorIdx: agg.colorIdx };
        }
        leafCentersRef.current = leafCenters;
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
      const { left, right, top, bottom } = insetsRef.current;
      const orbBounds = {
        minX: left,
        maxX: Math.max(left, W - right),
        minY: top,
        maxY: Math.max(top, H - bottom),
      };
      const explorationAnchors = Object.entries(centers)
        .filter(([, center]) => center.depth === 0)
        .map(([path, center]) => ({ path, x: center.x, y: center.y }));
      for (const [id, orb] of ingestOrbsRef.current) {
        try {
          const finalNode = orb.finalPaperId ? nodesByIdRef.current.get(orb.finalPaperId) : null;
          stepIngestOrb(orb, {
            now,
            dt,
            bounds: orbBounds,
            anchors: explorationAnchors,
            pointer: orbPointerRef.current,
            finalTarget: finalNode ? { x: finalNode.x, y: finalNode.y } : null,
            reducedMotion,
          });
        } catch {
          // Upload/data success never depends on this decorative lifecycle.
          cancelIngestOrb(orb, now);
        }
        if (shouldRemoveIngestOrb(orb, now)) ingestOrbsRef.current.delete(id);
      }
      const suppressedIds = new Set<string>();
      for (const orb of ingestOrbsRef.current.values()) {
        const paperId = suppressedPaperId(orb);
        if (paperId) suppressedIds.add(paperId);
      }

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

      if (!nodes.length) {
        // The upload lifecycle remains visible for a first-ever paper.
        ctx.save();
        ctx.translate(view.tx, view.ty);
        ctx.scale(view.k, view.k);
        for (const orb of ingestOrbsRef.current.values()) drawIngestOrb(ctx, orb, now);
        ctx.restore();
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

      // ── Constellation edges — stable ID topology with live endpoints. ──
      const alpha = 0.22 * (hasSimHighlight ? dimFactor : 1);
      for (const [aId, bId] of constellationEdgesRef.current) {
        const a = nodesByIdRef.current.get(aId);
        const b = nodesByIdRef.current.get(bId);
        if (!a || !b) continue;
        const col = PALETTE[a.colorIdx % PALETTE.length];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = col.glow + alpha.toFixed(3) + ")";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // ── Constellation leaf labels — only leaves with ≥3 members, faded
      // in over a mid zoom range so they don't confetti at extremes. The
      // tour's active stop stays fully visible regardless of zoom (still
      // capped at the same 0.4 alpha budget, just without the k-based fade
      // dragging it toward 0 mid-flight). ────────────────────────────────
      const leafLabelFade = triangleFade(view.k, 0.6, 1.2, 2.6);
      const highlightPath = highlightPathRef.current;
      for (const [leaf, c] of Object.entries(leafCentersRef.current)) {
        if (c.count < 3) continue;
        const isHighlighted = !!highlightPath && leaf === highlightPath;
        const fade = isHighlighted ? 1 : leafLabelFade;
        if (fade <= 0.001) continue;
        const col = PALETTE[c.colorIdx % PALETTE.length];
        ctx.save();
        ctx.globalAlpha = 0.4 * fade;
        ctx.fillStyle = col.stroke;
        ctx.font = "600 11px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(leaf.split("/").pop()!, c.x, c.y);
        ctx.restore();
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

          // Percentage label near midpoint, counter-scaled to stay screen-sized.
          const pct = Math.round(nb.score * 100);
          ctx.save();
          ctx.font = `600 ${11 / view.k}px Inter, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.fillText(`${pct}%`, mx, my - 6 / view.k);
          ctx.restore();
        }
      }

      // ── Nodes ─────────────────────────────────────────────────────────
      for (const n of nodes) {
        if (suppressedIds.has(n.id)) continue;
        const isHov = hov?.id === n.id;
        const isSimNeighbor = hasSimHighlight && simNeighborIds.has(n.id);
        const nodeDim = hasSimHighlight && !isHov && !isSimNeighbor ? dimFactor : 1;
        const isRead  = n.paper.status === "read";
        const isRogue = n.l1 === "Misc" || n.l1 === "Unclustered";
        const col     = isRogue ? ROGUE_COLOR : PALETTE[n.colorIdx % PALETTE.length];
        const rogueDim = isRogue ? 0.7 : 1;
        const r     = isHov ? NODE_R + 4 : NODE_R;

        const renderX = n.x;
        const renderY = n.y;

        // Comet trail (recency) — fixed shared angle, drawn before the star
        // itself so the star's halo sits on top of the trail's near end.
        if (n.comet > 0.001) {
          const len = 26 * n.comet;
          const ang = -35 * (Math.PI / 180);
          const tx2 = renderX + Math.cos(ang) * len;
          const ty2 = renderY + Math.sin(ang) * len;
          ctx.beginPath();
          ctx.moveTo(renderX, renderY);
          ctx.lineTo(tx2, ty2);
          ctx.strokeStyle = `rgba(235,242,255,${(0.35 * n.comet * nodeDim).toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        if (isRead) {
          // ── Ignited star: single halo + solid warm-white core ──
          const glowR = r * (isHov ? 5.5 : 3.5);
          const grd = ctx.createRadialGradient(renderX, renderY, r * 0.1, renderX, renderY, glowR);
          grd.addColorStop(0, col.glow + ((isHov ? 0.5 : 0.3) * nodeDim * rogueDim).toFixed(3) + ")");
          grd.addColorStop(1, "transparent");
          ctx.beginPath();
          ctx.arc(renderX, renderY, glowR, 0, Math.PI * 2);
          ctx.fillStyle = grd;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(renderX, renderY, isHov ? 3.2 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(240,246,255,${(0.95 * nodeDim * rogueDim).toFixed(3)})`;
          ctx.fill();
        } else {
          // ── Protostar: hollow ring in the cluster hue, faint halo, no core ──
          const glowR = r * 2.2;
          const grd = ctx.createRadialGradient(renderX, renderY, r * 0.1, renderX, renderY, glowR);
          grd.addColorStop(0, col.glow + ((isHov ? 0.22 : 0.10) * nodeDim * rogueDim).toFixed(3) + ")");
          grd.addColorStop(1, "transparent");
          ctx.beginPath();
          ctx.arc(renderX, renderY, glowR, 0, Math.PI * 2);
          ctx.fillStyle = grd;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(renderX, renderY, isHov ? 4.5 : 3.5, 0, Math.PI * 2);
          ctx.globalAlpha = nodeDim * rogueDim;
          ctx.strokeStyle = col.stroke + (isHov ? "dd" : "88");
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

      }

      // ── Ignition flares — one-shot expanding ring when a star lights up ──
      if (ignitionsRef.current.length) {
        ignitionsRef.current = ignitionsRef.current.filter(ig => now - ig.start < 500);
        for (const ig of ignitionsRef.current) {
          const t = (now - ig.start) / 500;
          const ringR = lerp(4, 34, easeOutCubic(t));
          const ringA = 1 - t;
          ctx.beginPath();
          ctx.arc(ig.x, ig.y, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(240,246,255,${ringA.toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.stroke();

          if (t < 0.3) {
            const overshoot = 1 - t / 0.3;
            ctx.beginPath();
            ctx.arc(ig.x, ig.y, 2.5 + overshoot * 2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(240,246,255,${overshoot.toFixed(3)})`;
            ctx.fill();
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

      // The orb is decorative and never participates in hit testing.
      for (const orb of ingestOrbsRef.current.values()) drawIngestOrb(ctx, orb, now);

      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // ── Focus labels — only hovered or pinned papers speak on the canvas. ──
      const selectedId = selectedPaperIdRef.current;
      const labelDetails = new Map<string, { title: string; meta: string; alpha: number; focused: boolean }>();
      const candidates: LabelCandidate[] = [];
      const obstacles: LabelRect[] = [];
      const bounds = {
        left: insetsRef.current.left,
        right: W - insetsRef.current.right,
        top: insetsRef.current.top,
        bottom: H - insetsRef.current.bottom,
      };

      ctx.font = "500 12px Inter, system-ui, sans-serif";
      for (const n of nodes) {
        if (suppressedIds.has(n.id)) continue;
        const x = n.x * view.k + view.tx;
        const y = n.y * view.k + view.ty;
        if (x < bounds.left - 230 || x > bounds.right + 230 || y < bounds.top - 40 || y > bounds.bottom + 40) continue;

        const screenRadius = Math.min(18, Math.max(6, NODE_R * view.k));
        obstacles.push({ x: x - screenRadius, y: y - screenRadius, width: screenRadius * 2, height: screenRadius * 2 });

        const isHovered = hov?.id === n.id;
        const isSelected = selectedId === n.id;
        const focused = isHovered || isSelected;
        if (!focused) continue;

        const rawTitle = n.paper.title || n.paper.filename.replace(/\.pdf$/i, "");
        const title = ellipsizeLabel(rawTitle, 210, value => ctx.measureText(value).width);
        const titleWidth = ctx.measureText(title).width;
        const rawMeta = [n.paper.author, n.paper.year].filter(Boolean).join(" · ");
        ctx.font = "400 11px Inter, system-ui, sans-serif";
        const meta = focused && rawMeta
          ? ellipsizeLabel(rawMeta, 210, value => ctx.measureText(value).width)
          : "";
        const metaWidth = meta ? ctx.measureText(meta).width : 0;
        ctx.font = "500 12px Inter, system-ui, sans-serif";
        const width = Math.max(titleWidth, metaWidth);

        candidates.push({
          id: n.id,
          x,
          y,
          width,
          height: meta ? 29 : 15,
          offset: screenRadius + 7,
          priority: isHovered ? 10_000 : 9_000,
          required: true,
        });
        labelDetails.set(n.id, {
          title,
          meta,
          alpha: 1,
          focused,
        });
      }

      const labels = placeSemanticLabels(
        candidates,
        bounds,
        obstacles,
        0,
        labelAnchorsRef.current,
      );
      labelAnchorsRef.current = new Map(labels.map(label => [label.id, label.anchor]));

      for (const label of labels) {
        const detail = labelDetails.get(label.id);
        if (!detail) continue;
        ctx.save();
        ctx.globalAlpha = detail.alpha;
        if (detail.focused) {
          const lineX = Math.max(label.rect.x, Math.min(label.x, label.rect.x + label.rect.width));
          const lineY = Math.max(label.rect.y, Math.min(label.y, label.rect.y + label.rect.height));
          ctx.beginPath();
          ctx.moveTo(label.x, label.y);
          ctx.lineTo(lineX, lineY);
          ctx.strokeStyle = "rgba(148,163,184,0.38)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.shadowColor = "rgba(7,9,14,0.95)";
        ctx.shadowBlur = 5;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.font = detail.focused
          ? "600 12px Inter, system-ui, sans-serif"
          : "500 12px Inter, system-ui, sans-serif";
        ctx.fillStyle = "rgba(226,232,240,0.94)";
        ctx.fillText(detail.title, label.rect.x, label.rect.y);
        if (detail.meta) {
          ctx.font = "400 11px Inter, system-ui, sans-serif";
          ctx.fillStyle = "rgba(148,163,184,0.88)";
          ctx.fillText(detail.meta, label.rect.x, label.rect.y + 16);
        }
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = null;
      if (document.visibilityState === "visible") rafRef.current = requestAnimationFrame(loop);
    };
    const onVisibilityChange = () => start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = null;
    };
  }, [active]);

  // ── Screen <-> world coordinate helpers ──────────────────────────────────
  const toWorld = useCallback((mx: number, my: number) => {
    const { k, tx, ty } = viewRef.current;
    return { x: (mx - tx) / k, y: (my - ty) / k };
  }, []);

  const hitNode = useCallback((mx: number, my: number) => {
    const world = toWorld(mx, my);
    let closest: GNode | null = null;
    let minD = 26 / viewRef.current.k;
    for (const node of nodesRef.current) {
      const distance = Math.hypot(node.x - world.x, node.y - world.y);
      if (distance < minD) { minD = distance; closest = node; }
    }
    return closest;
  }, [toWorld]);

  // ── Pointer events: node drag or empty-canvas pan ────────────────────────
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    orbPointerRef.current = toWorld(mx, my);

    const drag = dragRef.current;
    if (drag.mode !== "none" && drag.pointerId === e.pointerId) {
      const dx = mx - drag.lastX;
      const dy = my - drag.lastY;
      drag.moved = Math.hypot(mx - drag.downX, my - drag.downY);
      drag.lastX = mx;
      drag.lastY = my;
      if (drag.mode === "pan" && drag.moved > DRAG_THRESHOLD) {
        cameraAnimRef.current = null;
        viewRef.current = {
          k: viewRef.current.k,
          tx: viewRef.current.tx + dx,
          ty: viewRef.current.ty + dy,
        };
        setCursor("grabbing");
      } else if (drag.mode === "node" && drag.node) {
        const world = toWorld(mx, my);
        const elapsed = Math.max(1, e.timeStamp - drag.lastMoveAt) / 1000;
        const rawVx = (world.x - drag.lastWorldX) / elapsed;
        const rawVy = (world.y - drag.lastWorldY) / elapsed;
        const speed = Math.hypot(rawVx, rawVy);
        const scale = speed > RELEASE_SPEED ? RELEASE_SPEED / speed : 1;
        drag.releaseVx = rawVx * scale;
        drag.releaseVy = rawVy * scale;
        drag.lastWorldX = world.x;
        drag.lastWorldY = world.y;
        drag.lastMoveAt = e.timeStamp;
        drag.node.drag = world;
        drag.node.x = world.x;
        drag.node.y = world.y;
        setCursor("grabbing");
      }
      return;
    }

    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const closest = hitNode(mx, my);
    if (closest?.id !== hovRef.current?.id) {
      hovRef.current = closest;
      setCursor(closest ? "pointer" : "default");
      onHover?.(closest?.paper ?? null);
    }
  }, [hitNode, onHover, toWorld]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const node = hitNode(mx, my);
    const world = toWorld(mx, my);
    dragRef.current = {
      mode: node ? "node" : "pan",
      pointerId: e.pointerId,
      node,
      moved: 0,
      lastX: mx,
      lastY: my,
      downX: mx,
      downY: my,
      lastWorldX: world.x,
      lastWorldY: world.y,
      lastMoveAt: e.timeStamp,
      releaseVx: 0,
      releaseVy: 0,
    };
    if (node) {
      node.drag = world;
      cameraAnimRef.current = null;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [hitNode, toWorld]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.mode === "none" || drag.pointerId !== e.pointerId) return;
    const wasDrag = drag.moved > DRAG_THRESHOLD;
    const draggedNode = drag.node;
    const mode = drag.mode;
    drag.mode = "none";
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);

    if (draggedNode) {
      draggedNode.drag = null;
      if (reducedMotionRef.current) {
        const home = draggedNode.anchors[draggedNode.anchors.length - 1];
        if (home) { draggedNode.x = home.x; draggedNode.y = home.y; }
        draggedNode.vx = 0;
        draggedNode.vy = 0;
        draggedNode.recovery = 0;
      } else if (wasDrag) {
        const releaseIsFresh = e.timeStamp - drag.lastMoveAt <= RELEASE_VELOCITY_WINDOW_MS;
        draggedNode.vx = releaseIsFresh ? drag.releaseVx : 0;
        draggedNode.vy = releaseIsFresh ? drag.releaseVy : 0;
        recoverGalaxyAfterDrag(nodesRef.current, draggedNode);
      }
    }

    const hoverNode = (e.pointerType === "mouse" || e.pointerType === "pen")
      ? hitNode(e.clientX - e.currentTarget.getBoundingClientRect().left, e.clientY - e.currentTarget.getBoundingClientRect().top)
      : null;
    hovRef.current = hoverNode;
    setCursor(hoverNode ? "pointer" : "default");
    if (wasDrag) return;

    // Treat as click: either open the hovered paper, or hit-test a cluster
    // aura/label to trigger a camera glide.
    if (mode === "node" && draggedNode) { onOpenPaper?.(draggedNode.paper); return; }

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
  }, [glideToClusterPath, hitNode, onOpenPaper, toWorld]);

  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.mode === "none" || drag.pointerId !== e.pointerId) return;
    if (drag.node) {
      drag.node.drag = null;
      drag.node.vx = 0;
      drag.node.vy = 0;
      if (reducedMotionRef.current) {
        const home = drag.node.anchors[drag.node.anchors.length - 1];
        if (home) { drag.node.x = home.x; drag.node.y = home.y; }
        drag.node.recovery = 0;
      } else {
        recoverGalaxyAfterDrag(nodesRef.current, drag.node);
      }
    }
    drag.mode = "none";
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setCursor("default");
  }, []);

  const onPointerLeave = useCallback(() => {
    orbPointerRef.current = null;
    if (dragRef.current.mode !== "none") return;
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

  const spawnIngestOrbLifecycle = useCallback((seed: string): IngestOrbHandle => {
    const canvas = canvasRef.current;
    const W = canvas?.width || canvas?.offsetWidth || 800;
    const H = canvas?.height || canvas?.offsetHeight || 600;
    const { left, right, top, bottom } = insetsRef.current;
    const id = ingestOrbIdSeq++;
    const now = performance.now();
    const orb = createIngestOrbState(id, seed, now, {
      minX: left,
      maxX: Math.max(left, W - right),
      minY: top,
      maxY: Math.max(top, H - bottom),
    }, reducedMotionRef.current);
    ingestOrbsRef.current.set(id, orb);

    return {
      update(progress) {
        try {
          const current = ingestOrbsRef.current.get(id);
          if (current) updateIngestOrb(current, progress);
        } catch {
          const current = ingestOrbsRef.current.get(id);
          if (current) cancelIngestOrb(current, performance.now());
        }
      },
      resolve(paper) {
        try {
          const current = ingestOrbsRef.current.get(id);
          if (current) resolveIngestOrb(current, paper, performance.now());
        } catch {
          const current = ingestOrbsRef.current.get(id);
          if (current) cancelIngestOrb(current, performance.now());
        }
      },
      cancel() {
        const current = ingestOrbsRef.current.get(id);
        if (current) cancelIngestOrb(current, performance.now());
      },
    };
  }, []);

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
    spawnIngestOrb(seed: string) {
      return spawnIngestOrbLifecycle(seed);
    },
    focusCluster(path: string | null) {
      glideToClusterPath(path);
    },
    igniteStar(paperId: string) {
      const n = nodesRef.current.find(n => n.id === paperId);
      if (n) ignitionsRef.current.push({ x: n.x, y: n.y, start: performance.now() });
    },
  }), [glideToClusterPath, spawnIngestOrbLifecycle]);

  const getParallax = useCallback(() => viewRef.current, []);

  return (
    <div className="relative w-full h-full">
      <StarfieldCanvas className="absolute inset-0 w-full h-full pointer-events-none" getParallax={getParallax} />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ cursor, touchAction: "none" }}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
});

function drawIngestOrb(ctx: CanvasRenderingContext2D, orb: IngestOrbState, now: number) {
  if (orb.motion.phase === "complete") {
    if (orb.reducedMotion) return;
    const t = Math.min(1, (now - (orb.completedAt ?? now)) / 700);
    const rippleR = lerp(4, 60, easeOutCubic(t));
    const rippleA = (1 - t) * 0.8;
    ctx.beginPath();
    ctx.arc(orb.position.x, orb.position.y, rippleR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${rippleA.toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    return;
  }

  const alpha = ingestOrbOpacity(orb, now);
  if (alpha <= 0) return;
  const envelope = getPhaseEnvelope(orb.motion.phase, orb.motion.pct, orb.reducedMotion);
  const glowR = 18 + envelope.intensity * 8;
  const { x, y } = orb.position;
  const grd = ctx.createRadialGradient(x, y, 0, x, y, glowR);
  grd.addColorStop(0, `rgba(125,235,255,${(0.55 * alpha).toFixed(3)})`);
  grd.addColorStop(1, "transparent");
  ctx.beginPath();
  ctx.arc(x, y, glowR, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${(0.95 * alpha).toFixed(3)})`;
  ctx.shadowColor = "rgba(125,235,255,0.9)";
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;
}
