import { useEffect, useRef } from "react";

interface Streak {
  angle: number;
  dist0: number;
  speed: number;
  len: number;
}

const TOTAL_MS = 900;
const SWAP_AT_MS = 650;
const FADE_IN_MS = 120;
const FADE_OUT_START_MS = 650;

/**
 * Fullscreen star-streak transition played over a scene swap. `onSwap` fires
 * once at the 650ms mark (destination should already be mounted behind the
 * overlay); `onDone` fires once at the end so the caller can unmount this.
 * Same visual plays for `reverse` — it reads fine in both directions.
 */
export function WarpOverlay({
  onSwap,
  onDone,
}: {
  onSwap: () => void;
  onDone: () => void;
  reverse?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onSwapRef = useRef(onSwap);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onSwapRef.current = onSwap; }, [onSwap]);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      onSwapRef.current();
      onDoneRef.current();
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const streaks: Streak[] = Array.from({ length: 90 }, () => ({
      angle: Math.random() * Math.PI * 2,
      dist0: 20 + Math.random() * 100,
      speed: 0.6 + Math.random() * 0.8,
      len: 40 + Math.random() * 120,
    }));

    const start = performance.now();
    let swapped = false;
    let done = false;
    let rafId = 0;

    const loop = () => {
      const now = performance.now();
      const t = now - start;
      const W = canvas.width;
      const H = canvas.height;
      const cx = W / 2;
      const cy = H / 2;

      let envelope: number;
      if (t < FADE_IN_MS) envelope = t / FADE_IN_MS;
      else if (t < FADE_OUT_START_MS) envelope = 1;
      else envelope = Math.max(0, 1 - (t - FADE_OUT_START_MS) / (TOTAL_MS - FADE_OUT_START_MS));

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = `rgba(3,5,10,${(0.92 * envelope).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);

      const tt = Math.min(1, t / TOTAL_MS);
      const te = tt * tt; // accelerate
      const reach = Math.max(W, H) * 1.2;
      for (const s of streaks) {
        const dist = s.dist0 + te * s.speed * reach;
        const trail = s.len * Math.max(0.15, tt);
        const x1 = cx + Math.cos(s.angle) * dist;
        const y1 = cy + Math.sin(s.angle) * dist;
        const x0 = cx + Math.cos(s.angle) * (dist - trail);
        const y0 = cy + Math.sin(s.angle) * (dist - trail);
        ctx.strokeStyle = `rgba(220,230,255,${(0.8 * envelope).toFixed(3)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      if (!swapped && t >= SWAP_AT_MS) {
        swapped = true;
        onSwapRef.current();
      }
      if (!done && t >= TOTAL_MS) {
        done = true;
        onDoneRef.current();
        return;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 z-[100] pointer-events-none" />;
}
