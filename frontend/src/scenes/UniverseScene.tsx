import { useEffect, useState } from "react";
import clsx from "clsx";
import { StarfieldCanvas } from "../components/StarfieldCanvas";
import { Gate } from "../components/Gate";
import { listPapers } from "../api/client";
import { computeGalaxyStats, FAKE_GALAXIES } from "../lib/galaxy";
import type { Session } from "../auth/session";

const HUE_DOTS = ["#22d3ee", "#a78bfa", "#34d399", "#f59e0b", "#22d3ee"];

interface OwnerStats {
  stars: number;
  ignited: number;
  constellations: number;
}

export function UniverseScene({
  session,
  onVisitObserver,
  onEnter,
  onContinue,
}: {
  session: Session | null;
  /** Warp straight to Omar's galaxy in observer mode — zero auth interaction. */
  onVisitObserver: () => void;
  /** Fired once the Gate modal accepts a login/signup. */
  onEnter: (username: string) => void;
  /** Warp to the existing session's galaxy without re-authenticating. */
  onContinue: (username: string) => void;
}) {
  const [ownerStats, setOwnerStats] = useState<OwnerStats | null>(null);
  const [ownerFailed, setOwnerFailed] = useState(false);
  const [gateVariant, setGateVariant] = useState<"login" | "signup" | null>(null);
  const [sealedToast, setSealedToast] = useState<string | null>(null);
  const [wiggling, setWiggling] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPapers()
      .then(papers => {
        if (cancelled) return;
        const stats = computeGalaxyStats(papers);
        setOwnerStats(stats);
      })
      .catch(() => { if (!cancelled) setOwnerFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const sealGalaxy = (displayName: string) => {
    setWiggling(displayName);
    window.setTimeout(() => setWiggling(null), 200);
    setSealedToast("This galaxy is sealed.");
    window.setTimeout(() => setSealedToast(null), 2200);
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-bg text-ink dark">
      <StarfieldCanvas className="absolute inset-0 w-full h-full pointer-events-none" />

      <div className="absolute left-5 top-5 z-10 text-[11px] font-semibold uppercase tracking-[0.35em] text-muted">
        orrery
      </div>

      {/* ── Desktop: glyph field ── */}
      <div className="relative z-10 hidden h-full w-full lg:flex items-center justify-center">
        <div className="relative h-[560px] w-[720px]">
          {/* Omar's galaxy — real data, center */}
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3">
            <GalaxyGlyph size={150} opacity={1} />
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="text-sm font-semibold text-ink">Omar's galaxy</span>
              <span className="text-[11px] text-muted tabular-nums">
                {ownerFailed
                  ? "signal lost"
                  : ownerStats
                    ? `${ownerStats.stars} stars · ${ownerStats.ignited} ignited · ${ownerStats.constellations} constellations`
                    : "reading the sky…"}
              </span>
              <span className="mt-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                open to visitors
              </span>
              <button
                onClick={onVisitObserver}
                className="mt-2 rounded-lg bg-cyan-500/15 px-3.5 py-1.5 text-[12px] font-semibold text-cyan-400 hover:bg-cyan-500/25 transition-colors"
              >
                Visit as observer
              </button>
            </div>
          </div>

          {/* Fake galaxies — sealed, atmospheric only */}
          {FAKE_GALAXIES.map((g, i) => (
            <button
              key={g.username}
              onClick={() => sealGalaxy(g.displayName)}
              className={clsx(
                "absolute flex flex-col items-center gap-1.5 transition-transform",
                wiggling === g.displayName && "animate-wiggle",
              )}
              style={i === 0 ? { left: 40, top: 40 } : { right: 40, bottom: 60 }}
            >
              <GalaxyGlyph size={60} opacity={0.7} locked />
              <span className="text-[10px] text-muted">{g.displayName}</span>
              <span className="text-[9px] text-wire">private</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Mobile: stacked cards ── */}
      <div className="relative z-10 flex h-full w-full flex-col gap-3 overflow-y-auto p-5 pt-16 lg:hidden">
        <div className="rounded-2xl glass p-4">
          <span className="text-sm font-semibold text-ink">Omar's galaxy</span>
          <p className="mt-1 text-[11px] text-muted tabular-nums">
            {ownerFailed
              ? "signal lost"
              : ownerStats
                ? `${ownerStats.stars} stars · ${ownerStats.ignited} ignited · ${ownerStats.constellations} constellations`
                : "reading the sky…"}
          </p>
          <button
            onClick={onVisitObserver}
            className="mt-3 rounded-lg bg-cyan-500/15 px-3.5 py-1.5 text-[12px] font-semibold text-cyan-400"
          >
            Visit as observer
          </button>
        </div>
        {FAKE_GALAXIES.map(g => (
          <button
            key={g.username}
            onClick={() => sealGalaxy(g.displayName)}
            className="rounded-2xl glass p-4 text-left"
          >
            <span className="text-sm font-semibold text-muted">{g.displayName}</span>
            <p className="mt-1 text-[10px] text-wire">private</p>
          </button>
        ))}
      </div>

      {/* ── Bottom-center auth affordances ── */}
      <div className="absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3">
        <button
          onClick={() => setGateVariant("login")}
          className="rounded-lg glass px-3.5 py-2 text-[12px] font-medium text-zinc-300 hover:text-ink transition-colors"
        >
          Return to your galaxy
        </button>
        <button
          onClick={() => setGateVariant("signup")}
          className="rounded-lg glass px-3.5 py-2 text-[12px] font-medium text-zinc-300 hover:text-ink transition-colors"
        >
          Ignite a new universe
        </button>
        {session && (
          <button
            onClick={() => onContinue(session.username)}
            className="rounded-lg px-3.5 py-2 text-[11px] font-medium text-muted hover:text-zinc-300 transition-colors"
          >
            Continue as {session.username}
          </button>
        )}
      </div>

      {sealedToast && (
        <div className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-full glass px-4 py-1.5 text-[11px] text-zinc-300 animate-fade-up">
          {sealedToast}
        </div>
      )}

      {gateVariant && (
        <Gate
          variant={gateVariant}
          onClose={() => setGateVariant(null)}
          onEnter={(username) => { setGateVariant(null); onEnter(username); }}
        />
      )}
    </div>
  );
}

function GalaxyGlyph({ size, opacity, locked }: { size: number; opacity: number; locked?: boolean }) {
  const dotR = size * 0.32;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size, opacity }}
    >
      <div className="absolute inset-0 rounded-full border border-cyan-400/25" />
      <div className="absolute inset-[15%] rounded-full border border-violet-400/20" />
      <div className="absolute inset-[32%] rounded-full border border-emerald-400/20" />
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90"
        style={{ width: size * 0.09, height: size * 0.09, boxShadow: "0 0 12px rgba(255,255,255,0.6)" }}
      />
      {!locked && HUE_DOTS.map((c, i) => {
        const angle = (i / HUE_DOTS.length) * Math.PI * 2;
        const x = size / 2 + Math.cos(angle) * dotR;
        const y = size / 2 + Math.sin(angle) * dotR;
        return (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: x, top: y, width: size * 0.05, height: size * 0.05,
              background: c, boxShadow: `0 0 6px ${c}aa`, transform: "translate(-50%,-50%)",
            }}
          />
        );
      })}
    </div>
  );
}
