import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { PaperRecord } from "../api/client";
import type { PaperGraphHandle } from "./PaperGraph";
import { buildTourStops } from "../lib/tour";

type TourState =
  | { phase: "idle" }
  | { phase: "flying"; i: number }
  | { phase: "dwelling"; i: number }
  | { phase: "returning" };

const FLY_MS = 600;
const DWELL_MS = 3500;

/**
 * Autopilot tour: pure sequencing around PaperGraph's existing focusCluster —
 * no new camera code. Idle → flying(i) → dwelling(i) → … → returning → idle.
 */
export function TourController({
  papers,
  graphRef,
  suppressStart,
  onHighlightPath,
}: {
  papers: PaperRecord[];
  graphRef: React.RefObject<PaperGraphHandle | null>;
  /** Hide the start button while the omnibar sheet or reader is open. */
  suppressStart?: boolean;
  onHighlightPath: (path: string | null) => void;
}) {
  const stops = buildTourStops(papers);
  const [state, setState] = useState<TourState>({ phase: "idle" });
  const [pulse, setPulse] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Holds the step function so it can recurse without a self-referencing
  // useCallback (which the hooks linter's immutability check rejects).
  const stepRef = useRef<(i: number) => void>(() => {});

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const stop = useCallback(() => {
    clearTimer();
    setState(current => (current.phase === "idle" ? current : { phase: "idle" }));
    onHighlightPath(null);
  }, [onHighlightPath]);

  // Ref mutation belongs outside render — refresh it every commit so the
  // recursive step closure always sees the latest stops/graphRef/callback.
  useEffect(() => {
    stepRef.current = (i: number) => {
      setState({ phase: "flying", i });
      graphRef.current?.focusCluster(stops[i].path);
      onHighlightPath(stops[i].path);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setState({ phase: "dwelling", i });
        timerRef.current = window.setTimeout(() => {
          const next = i + 1;
          if (next >= stops.length) {
            setState({ phase: "returning" });
            graphRef.current?.focusCluster(null);
            onHighlightPath(null);
            clearTimer();
            timerRef.current = window.setTimeout(() => setState({ phase: "idle" }), FLY_MS);
          } else {
            stepRef.current(next);
          }
        }, DWELL_MS);
      }, FLY_MS);
    };
  });

  // Invite (never force) a tour: pulse the start button once ~2s after arrival.
  useEffect(() => {
    const onT = window.setTimeout(() => setPulse(true), 2000);
    const offT = window.setTimeout(() => setPulse(false), 4000);
    return () => { window.clearTimeout(onT); window.clearTimeout(offT); };
  }, []);

  // Abort on any user intent: wheel, mousedown on the canvas, or Escape. Leave
  // the camera exactly where the user grabbed it — no zoom-to-fit on abort.
  // Clicks inside glass chrome (sidebar, omnibar, StarCard, this tour's own
  // pill) don't count — only interaction with the graph itself does.
  useEffect(() => {
    if (state.phase === "idle") return;
    const isChrome = (e: Event) =>
      e.target instanceof Element && e.target.closest(".glass") != null;
    const onWheel = (e: Event) => { if (!isChrome(e)) stop(); };
    const onMouseDown = (e: Event) => { if (!isChrome(e)) stop(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") stop(); };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [state.phase, stop]);

  const start = useCallback(() => {
    if (!stops.length) return;
    setPulse(false);
    stepRef.current(0);
  }, [stops.length]);

  useEffect(() => () => clearTimer(), []);

  if (!stops.length) return null;

  const isRunning = state.phase !== "idle";

  return (
    <>
      {!isRunning && !suppressStart && (
        <button
          onClick={start}
          className={clsx(
            "absolute bottom-28 left-1/2 z-20 -translate-x-1/2 rounded-full glass px-4 py-2 text-[12px] font-semibold text-cyan-400 shadow-panel transition-opacity",
            pulse && "animate-pulse"
          )}
        >
          Take the tour
        </button>
      )}

      {(state.phase === "flying" || state.phase === "dwelling") && (
        <div className="absolute bottom-28 left-1/2 z-20 -translate-x-1/2 flex flex-col items-center gap-2">
          <div className="rounded-full glass px-4 py-2 text-[12px] text-zinc-300 shadow-panel">
            constellation {state.i + 1} of {stops.length} · {stops[state.i].label} · {stops[state.i].count} stars
          </div>
          <div className="flex gap-1">
            {stops.map((_, idx) => (
              <span
                key={idx}
                className={clsx("h-0.5 w-6 rounded-full", idx <= state.i ? "bg-cyan-400" : "bg-rim")}
              />
            ))}
          </div>
          <span className="text-[10px] text-muted">esc or scroll to explore</span>
        </div>
      )}
    </>
  );
}
