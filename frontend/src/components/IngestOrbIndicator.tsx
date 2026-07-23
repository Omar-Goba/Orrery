import { mapIngestPhase, type IngestPhase } from "../lib/ingestMotion";

export interface IngestOrbIndicatorProps {
  step: string;
  pct: number;
  reducedMotion: boolean;
  className?: string;
}

const phaseRotation: Record<IngestPhase, number> = {
  arrival: -35,
  survey: 35,
  narrowing: 120,
  holding: 210,
  resolved: 270,
  canceled: 0,
  complete: 0,
};

export function IngestOrbIndicator({
  step,
  pct,
  reducedMotion,
  className = "",
}: IngestOrbIndicatorProps) {
  const phase = mapIngestPhase({ step, pct });
  const animated = !reducedMotion;
  const rotation = phaseRotation[phase];

  return (
    <span
      aria-hidden="true"
      data-ingest-phase={phase}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center ${className}`}
    >
      <svg viewBox="0 0 32 32" className="h-full w-full overflow-visible" focusable="false">
        <circle cx="16" cy="16" r="14" fill="none" stroke="rgb(34 211 238 / 0.12)" />
        <g
          data-testid="ingest-orbit"
          className={animated ? "origin-center animate-spin" : undefined}
          style={{ animationDuration: phase === "holding" ? "4s" : phase === "narrowing" ? "2.8s" : "2s" }}
        >
          <circle cx="16" cy="16" r={phase === "arrival" ? 10 : phase === "survey" ? 12 : 9} fill="none" stroke="rgb(139 92 246 / 0.45)" strokeDasharray="3 5" />
          <circle cx="16" cy="4" r="1.5" fill="rgb(221 228 240)" />
        </g>
        <g transform={`rotate(${rotation} 16 16)`} className={animated && phase !== "holding" ? "transition-transform duration-500" : undefined}>
          {phase === "arrival" && <path d="M5 16h5" stroke="rgb(34 211 238 / 0.75)" strokeLinecap="round" />}
          {phase === "survey" && <circle cx="8" cy="16" r="1" fill="rgb(34 211 238)" />}
          {phase === "narrowing" && <path d="M7 13l3 3-3 3" fill="none" stroke="rgb(34 211 238)" strokeLinecap="round" strokeLinejoin="round" />}
          {phase === "holding" && <circle cx="8" cy="16" r="1.25" fill="rgb(139 92 246)" />}
        </g>
        <circle
          data-testid="ingest-core-glow"
          cx="16"
          cy="16"
          r="6"
          fill="rgb(34 211 238 / 0.12)"
          className={animated ? "animate-pulse" : undefined}
        />
        <circle cx="16" cy="16" r="3" fill="rgb(221 228 240)" stroke="rgb(34 211 238)" strokeWidth="1" />
      </svg>
    </span>
  );
}
