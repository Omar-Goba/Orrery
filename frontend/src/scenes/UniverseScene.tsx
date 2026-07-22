import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { StarfieldCanvas } from "../components/StarfieldCanvas";
import { Gate } from "../components/Gate";
import { getTourGalaxy, listPublicGalaxies, type PublicGalaxy } from "../api/client";
import { positionGalaxies } from "../lib/galaxy";
import { OWNER_USERNAME, type Session } from "../auth/session";

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
  const [ownerName, setOwnerName] = useState("Omar");
  const [galaxies, setGalaxies] = useState<PublicGalaxy[]>([]);
  const [ownerFailed, setOwnerFailed] = useState(false);
  const [gateVariant, setGateVariant] = useState<"login" | "signup" | null>(null);
  const [sealedToast, setSealedToast] = useState<string | null>(null);
  const [wiggling, setWiggling] = useState<string | null>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0 });
  const cameraRef = useRef(camera);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const positionedGalaxies = useMemo(() => positionGalaxies(galaxies), [galaxies]);
  const isKeeperHome = session?.role === "keeper" && session.username === OWNER_USERNAME;
  const enterOwnerGalaxy = () => {
    if (isKeeperHome) onContinue(session.username);
    else onVisitObserver();
  };

  useEffect(() => {
    let cancelled = false;
    getTourGalaxy()
      .then(galaxy => {
        if (cancelled) return;
        setOwnerName(galaxy.display_name);
        setOwnerStats({
          stars: galaxy.stars,
          ignited: galaxy.ignited,
          constellations: galaxy.constellations,
        });
      })
      .catch(() => { if (!cancelled) setOwnerFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listPublicGalaxies()
      .then(result => { if (!cancelled) setGalaxies(result); })
      .catch(() => { if (!cancelled) setGalaxies([]); });
    return () => { cancelled = true; };
  }, []);

  const sealGalaxy = (displayName: string) => {
    setWiggling(displayName);
    window.setTimeout(() => setWiggling(null), 200);
    setSealedToast("This galaxy is sealed.");
    window.setTimeout(() => setSealedToast(null), 2200);
  };

  const moveCamera = (x: number, y: number) => {
    const next = {
      x: Math.max(-520, Math.min(520, x)),
      y: Math.max(-300, Math.min(300, y)),
    };
    cameraRef.current = next;
    setCamera(next);
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      cameraX: cameraRef.current.x,
      cameraY: cameraRef.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveCamera(drag.cameraX + event.clientX - drag.x, drag.cameraY + event.clientY - drag.y);
  };

  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-bg text-ink dark">
      <StarfieldCanvas
        className="absolute inset-0 w-full h-full pointer-events-none"
        getParallax={() => ({ tx: cameraRef.current.x, ty: cameraRef.current.y })}
      />

      <div
        aria-label="Galaxy map"
        className="absolute inset-0 z-[1] cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={startPan}
        onPointerMove={pan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
      >
        <div
          className="absolute left-1/2 top-1/2 h-[900px] w-[1400px]"
          style={{ transform: `translate(calc(-50% + ${camera.x}px), calc(-50% + ${camera.y}px))` }}
        >
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 text-center">
            <GalaxyGlyph size={150} opacity={1} />
            <div className="flex flex-col items-center gap-1">
              <span className="text-sm font-semibold text-ink">{ownerName}'s galaxy</span>
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
                onClick={enterOwnerGalaxy}
                className="mt-2 rounded-lg bg-cyan-500/15 px-3.5 py-1.5 text-[12px] font-semibold text-cyan-400 hover:bg-cyan-500/25 transition-colors"
              >
                {isKeeperHome ? "Enter your galaxy" : "Visit as observer"}
              </button>
            </div>
          </div>

          {positionedGalaxies.map((galaxy, index) => {
            const isHome = session?.username === galaxy.handle;
            const label = `${galaxy.display_name}'s galaxy`;
            return (
              <div
                key={galaxy.handle}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `calc(50% + ${galaxy.x}px)`, top: `calc(50% + ${galaxy.y}px)` }}
              >
                <button
                  onClick={() => isHome ? onContinue(galaxy.handle) : sealGalaxy(label)}
                  className={clsx(
                    "galaxy-float flex flex-col items-center gap-1.5",
                    wiggling === label && "animate-wiggle",
                  )}
                  style={{ animationDelay: `${index * -0.55}s` }}
                >
                  <GalaxyGlyph size={isHome ? 82 : 68} opacity={isHome ? 1 : 0.72} locked={!isHome} />
                  <span className={clsx("text-[10px]", isHome ? "text-ink" : "text-muted")}>{label}</span>
                  <span className={clsx("text-[9px]", isHome ? "text-cyan-400" : "text-wire")}>
                    {isHome ? "your galaxy" : "private"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="absolute left-5 top-5 z-10 text-[11px] font-semibold uppercase tracking-[0.35em] text-muted">
        orrery
      </div>

      <div className="pointer-events-none absolute right-5 top-5 z-10 text-[10px] text-wire">
        drag to explore
      </div>

      {/* ── Bottom-center auth affordances ── */}
      <div className="absolute bottom-8 left-1/2 z-10 flex w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-3">
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
      <div className="absolute inset-0 animate-[spin_24s_linear_infinite] motion-reduce:animate-none">
        {HUE_DOTS.map((c, i) => {
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
                opacity: locked ? 0.35 : 1,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
