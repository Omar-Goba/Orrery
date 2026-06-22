import { useCallback, useEffect, useRef, useState } from "react";
import type { PaperRecord } from "../api/client";
import { getPaperUrl } from "../api/client";

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
const ORBIT_DECAY = 0.50;   // each depth level's orbit radius = parent's × this

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

// ── Component ────────────────────────────────────────────────────────────────
export function PaperGraph({
  papers,
  onHover,
}: {
  papers: PaperRecord[];
  onHover?: (p: PaperRecord | null) => void;
  active?: boolean;
}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const nodesRef   = useRef<GNode[]>([]);
  const edgesRef   = useRef<Edge[]>([]);
  const centersRef = useRef<Record<string, CenterInfo>>({});
  const hovRef     = useRef<GNode | null>(null);
  const rafRef     = useRef<number>(0);
  const tickRef    = useRef(0);
  const [cursor, setCursor] = useState<"pointer" | "default">("default");

  // ── Build graph ─────────────────────────────────────────────────────────
  const buildGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !papers.length) {
      nodesRef.current = [];
      edgesRef.current = [];
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
    const R0 = Math.min(W, H) * 0.28;
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

    placeCenters("__ROOT__", W / 2, H / 2, R0, 0);
    centersRef.current = centers;

    // ── Build nodes ───────────────────────────────────────────────────────
    const nodes: GNode[] = papers.map(p => {
      const l1 = p.cluster_path?.split("/")[0] ?? "Unclustered";
      const colorIdx = l1ColorIdx[l1] ?? 0;
      // Start near the deepest available center for each paper
      const home = centers[p.cluster_path ?? l1] ?? centers[l1] ?? { x: W / 2, y: H / 2 };
      return {
        id: p.id,
        x: home.x + (Math.random() - 0.5) * 80,
        y: home.y + (Math.random() - 0.5) * 80,
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
  }, [papers]);

  // ── Canvas resize ────────────────────────────────────────────────────────
  useEffect(() => {
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
  }, [buildGraph]);

  // ── Render loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const loop = () => {
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
              const f  = REPULSION / (d2 + 1);
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

        // Integrate + border bounce
        for (const n of nodes) {
          n.vx *= DAMPING; n.vy *= DAMPING;
          n.x  += n.vx;   n.y  += n.vy;
          const pad = 55;
          if (n.x < pad)     { n.x = pad;     n.vx *= -0.3; }
          if (n.x > W - pad) { n.x = W - pad; n.vx *= -0.3; }
          if (n.y < pad)     { n.y = pad;      n.vy *= -0.3; }
          if (n.y > H - pad) { n.y = H - pad; n.vy *= -0.3; }
        }
        tickRef.current++;
      }

      // ── Clear ─────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, W, H);

      // Background dot grid
      ctx.fillStyle = "rgba(29,37,55,0.55)";
      const GRID = 38;
      for (let gx = GRID / 2; gx < W; gx += GRID)
        for (let gy = GRID / 2; gy < H; gy += GRID) {
          ctx.beginPath();
          ctx.arc(gx, gy, 0.65, 0, Math.PI * 2);
          ctx.fill();
        }

      if (!nodes.length) {
        ctx.fillStyle = "rgba(90,106,133,0.3)";
        ctx.font = "14px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No papers indexed yet", W / 2, H / 2);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      // ── Cluster auras (L1 large, L2 smaller, deeper = skip) ───────────
      for (const [prefix, c] of Object.entries(centers)) {
        if (c.depth > 1) continue;           // only L1 + L2 auras
        const col    = PALETTE[c.colorIdx % PALETTE.length];
        const auraR  = c.depth === 0 ? 160 : 80;
        const baseA  = c.depth === 0 ? 0.055 : 0.032;
        const grd    = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, auraR);
        grd.addColorStop(0, col.glow + baseA + ")");
        grd.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(c.x, c.y, auraR, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        // Ghost label — L1 only
        if (c.depth === 0) {
          ctx.save();
          ctx.globalAlpha = 0.055;
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
        const alpha  = Math.max(0, maxA - d / 1000);
        if (alpha < 0.005) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = col.glow + alpha.toFixed(3) + ")";
        ctx.lineWidth   = depth >= 3 ? 1.5 : 1;
        ctx.stroke();
      }

      // ── Nodes ─────────────────────────────────────────────────────────
      const hov = hovRef.current;
      for (const n of nodes) {
        const col   = PALETTE[n.colorIdx % PALETTE.length];
        const isHov = hov?.id === n.id;
        const r     = isHov ? NODE_R + 4 : NODE_R;

        // Glow halo
        const glowR = r * (isHov ? 5.5 : 3.5);
        const grd   = ctx.createRadialGradient(n.x, n.y, r * 0.1, n.x, n.y, glowR);
        grd.addColorStop(0, col.glow + (isHov ? "0.55)" : "0.3)"));
        grd.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        // Fill
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col.glow + (isHov ? "0.25)" : "0.1)");
        ctx.fill();

        // Ring
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = col.stroke + (isHov ? "ff" : "bb");
        ctx.lineWidth   = isHov ? 2 : 1.5;
        ctx.stroke();

        // Core dot
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = col.dot;
        ctx.fill();
      }

      // ── Hover tooltip ─────────────────────────────────────────────────
      if (hov) {
        const p   = hov.paper;
        const col = PALETTE[hov.colorIdx % PALETTE.length];
        const raw = (p.title ?? p.filename).replace(/\.pdf$/i, "");
        const text = raw.length > 46 ? raw.slice(0, 45) + "…" : raw;
        const sub  = [p.author, p.year].filter(Boolean).join("  ·  ");
        const status = p.status === "read" ? "read" : "to-read";
        // Show full cluster path in tooltip
        const path = p.cluster_path?.replace(/\//g, " › ") ?? "";

        ctx.font = "600 12px Inter, system-ui, sans-serif";
        const tw  = ctx.measureText(text).width;
        ctx.font  = "11px Inter, system-ui, sans-serif";
        const sw  = sub  ? ctx.measureText(sub).width  : 0;
        const pw  = path ? ctx.measureText(path).width : 0;
        const stw = ctx.measureText(status).width;
        const bw  = Math.max(tw, sw + stw + 16, pw) + 28;
        const bh  = 16 + 16 + (sub ? 16 : 0) + (path ? 15 : 0);

        let bx = hov.x + 16;
        let by = hov.y - bh / 2;
        if (bx + bw > W - 8) bx = hov.x - bw - 12;
        if (by < 6)          by = 6;
        if (by + bh > H - 6) by = H - bh - 6;

        ctx.shadowColor = col.stroke + "33";
        ctx.shadowBlur  = 16;
        ctx.fillStyle   = "rgba(10,13,21,0.94)";
        ctx.strokeStyle = col.stroke + "40";
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 8);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Title
        ctx.fillStyle = "#dde4f0";
        ctx.font = "600 12px Inter, system-ui, sans-serif";
        ctx.fillText(text, bx + 14, by + 17);

        let lineY = by + 33;

        // Author · year + status
        if (sub) {
          ctx.fillStyle = col.stroke + "cc";
          ctx.font = "11px Inter, system-ui, sans-serif";
          ctx.fillText(sub, bx + 14, lineY);
          const sx = bx + bw - stw - 14;
          ctx.fillStyle = p.status === "read" ? "rgba(52,211,153,0.85)" : "rgba(251,191,36,0.85)";
          ctx.fillText(status, sx, lineY);
          lineY += 15;
        }

        // Cluster path breadcrumb
        if (path) {
          ctx.fillStyle = "rgba(90,106,133,0.7)";
          ctx.font = "10px Inter, system-ui, sans-serif";
          ctx.fillText(path, bx + 14, lineY);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Mouse events ─────────────────────────────────────────────────────────
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let closest: GNode | null = null;
    let minD = 26;
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - mx, n.y - my);
      if (d < minD) { minD = d; closest = n; }
    }
    if (closest?.id !== hovRef.current?.id) {
      hovRef.current = closest;
      setCursor(closest ? "pointer" : "default");
      onHover?.(closest?.paper ?? null);
    }
  }, [onHover]);

  const onMouseLeave = useCallback(() => {
    hovRef.current = null;
    setCursor("default");
    onHover?.(null);
  }, [onHover]);

  const onClick = useCallback(() => {
    const p = hovRef.current?.paper;
    if (p?.id) window.open(getPaperUrl(p.id), "_blank");
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full block"
      style={{ cursor }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    />
  );
}
