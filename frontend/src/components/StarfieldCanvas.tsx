import { useEffect, useRef } from "react";

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

let shootIdSeq = 1;

function hash01(id: string, axis: number): number {
  let hash = axis;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(31, hash) + id.charCodeAt(i);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0xffffffff;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Three-layer parallax starfield with twinkle + ambient shooting stars.
 * Extracted from PaperGraph so PaperGraph and UniverseScene share one
 * source of truth for the background. Purely decorative — no pointer events.
 */
export function StarfieldCanvas({
  className,
  getParallax,
}: {
  className?: string;
  /** Polled once per frame for the current pan offset; omit for a static field. */
  getParallax?: () => { tx: number; ty: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<{ near: Star[]; mid: Star[]; far: Star[] }>({ near: [], mid: [], far: [] });
  const shootingRef = useRef<ShootingStar[]>([]);
  const nextShootAtRef = useRef(0);
  const rafRef = useRef(0);
  const getParallaxRef = useRef(getParallax);
  useEffect(() => { getParallaxRef.current = getParallax; }, [getParallax]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mkLayer = (count: number, seedBase: number, W: number, H: number): Star[] => {
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

    const build = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (w < 10 || h < 10) return;
      canvas.width = w;
      canvas.height = h;
      starsRef.current = {
        far:  mkLayer(280, 1, w, h),
        mid:  mkLayer(190, 3, w, h),
        near: mkLayer(130, 2, w, h),
      };
      shootingRef.current = [];
      nextShootAtRef.current = performance.now() + 1500 + Math.random() * 2500;
    };
    const ro = new ResizeObserver(build);
    ro.observe(canvas);
    build();

    const drawLayer = (
      stars: Star[], parallax: number, alpha: number, driftSpeed: number,
      now: number, px: number, py: number,
    ) => {
      for (const s of stars) {
        const dx = Math.sin(now / 4000 * driftSpeed + s.phase) * 3;
        const dy = Math.cos(now / 5000 * driftSpeed + s.phase) * 3;
        const x = s.x + px * parallax + dx;
        const y = s.y + py * parallax + dy;
        const twinkle = 0.5 + 0.5 * Math.sin(now / 1000 * s.twinkleSpeed + s.phase * 2);
        ctx.fillStyle = `rgba(210,225,255,${alpha * (0.4 + 0.6 * twinkle)})`;
        ctx.beginPath();
        ctx.arc(x, y, s.r * (0.8 + 0.4 * twinkle), 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = () => {
      const now = performance.now();
      const W = canvas.width;
      const H = canvas.height;
      if (W < 10 || H < 10) { rafRef.current = requestAnimationFrame(loop); return; }
      ctx.clearRect(0, 0, W, H);

      const { tx, ty } = getParallaxRef.current?.() ?? { tx: 0, ty: 0 };
      drawLayer(starsRef.current.far,  0.04,  0.35, 0.6, now, tx, ty);
      drawLayer(starsRef.current.mid,  0.065, 0.5,  0.8, now, tx, ty);
      drawLayer(starsRef.current.near, 0.09,  0.7,  1.0, now, tx, ty);

      if (now >= nextShootAtRef.current) {
        const ang = Math.PI * 0.15 + Math.random() * Math.PI * 0.1;
        const len = Math.max(W, H) * (0.5 + Math.random() * 0.4);
        const x0 = Math.random() * W * 0.6;
        const y0 = Math.random() * H * 0.3;
        shootingRef.current.push({
          id: shootIdSeq++,
          x0, y0,
          x1: x0 + Math.cos(ang) * len,
          y1: y0 + Math.sin(ang) * len,
          start: now,
          duration: 700 + Math.random() * 400,
        });
        nextShootAtRef.current = now + 1800 + Math.random() * 3200;
      }
      if (shootingRef.current.length) {
        shootingRef.current = shootingRef.current.filter(ss => now - ss.start < ss.duration);
        for (const ss of shootingRef.current) {
          const t = (now - ss.start) / ss.duration;
          const head = Math.min(1, t * 1.4);
          const tail = Math.max(0, head - 0.35);
          const hx = lerp(ss.x0, ss.x1, head);
          const hy = lerp(ss.y0, ss.y1, head);
          const tailX = lerp(ss.x0, ss.x1, tail);
          const tailY = lerp(ss.y0, ss.y1, tail);
          const fade = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
          const grad = ctx.createLinearGradient(tailX, tailY, hx, hy);
          grad.addColorStop(0, "rgba(210,225,255,0)");
          grad.addColorStop(1, `rgba(230,240,255,${0.85 * fade})`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(hx, hy);
          ctx.stroke();
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, []);

  return <canvas ref={canvasRef} className={className} />;
}
