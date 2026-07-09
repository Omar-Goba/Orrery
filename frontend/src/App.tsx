import { useEffect, useState } from "react";
import { UniverseScene } from "./scenes/UniverseScene";
import { GalaxyScene } from "./scenes/GalaxyScene";
import { WarpOverlay } from "./scenes/WarpOverlay";
import { getSession, logout, OWNER_USERNAME, refreshSession, type GalaxyMode } from "./auth/session";

type GalaxyId = string; // "omar" | any fake/visitor username

type DisplayScene =
  | { name: "universe" }
  | { name: "galaxy"; galaxy: GalaxyId };

interface Warping {
  to: GalaxyId;
  reverse: boolean;
}

const SCENE_KEY = "orrery.scene";

function loadInitialScene(): DisplayScene {
  if (new URLSearchParams(window.location.search).has("reset")) {
    sessionStorage.removeItem(SCENE_KEY);
    return { name: "universe" };
  }
  try {
    const raw = sessionStorage.getItem(SCENE_KEY);
    if (raw) return JSON.parse(raw) as DisplayScene;
  } catch {
    // fall through to default
  }
  return { name: "universe" };
}

export default function App() {
  const [displayed, setDisplayed] = useState<DisplayScene>(loadInitialScene);
  const [warping, setWarping] = useState<Warping | null>(null);
  const [session, setSession] = useState(() => getSession());

  useEffect(() => {
    sessionStorage.setItem(SCENE_KEY, JSON.stringify(displayed));
  }, [displayed]);

  useEffect(() => {
    let cancelled = false;
    refreshSession().then((fresh) => {
      if (!cancelled) setSession(fresh);
    });
    return () => { cancelled = true; };
  }, []);

  const beginWarp = (to: GalaxyId, reverse = false) => {
    // Never let two warps overlap — a click mid-transition is a no-op.
    setWarping(current => current ?? { to, reverse });
  };

  const modeFor = (galaxy: GalaxyId): GalaxyMode =>
    session?.isOwner && galaxy === OWNER_USERNAME ? "owner" : "observer";

  return (
    <>
      {displayed.name === "universe" ? (
        <UniverseScene
          session={session}
          onVisitObserver={() => beginWarp(OWNER_USERNAME)}
          onEnter={(username) => {
            setSession(getSession());
            beginWarp(username);
          }}
          onContinue={(username) => beginWarp(username)}
        />
      ) : (
        <GalaxyScene
          key={displayed.galaxy}
          galaxy={displayed.galaxy}
          mode={modeFor(displayed.galaxy)}
          onExitToUniverse={() => beginWarp(displayed.galaxy, true)}
          onLogout={
            modeFor(displayed.galaxy) === "owner"
              ? () => {
                  void logout();
                  setSession(null);
                  beginWarp(displayed.galaxy, true);
                }
              : undefined
          }
          initialView={{ k: 0.55 }}
        />
      )}

      {warping && (
        <WarpOverlay
          reverse={warping.reverse}
          onSwap={() => {
            setDisplayed(
              warping.reverse ? { name: "universe" } : { name: "galaxy", galaxy: warping.to }
            );
          }}
          onDone={() => setWarping(null)}
        />
      )}
    </>
  );
}
