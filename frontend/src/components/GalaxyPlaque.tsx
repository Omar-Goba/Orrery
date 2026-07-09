import { useEffect, useState } from "react";
import type { PaperRecord } from "../api/client";
import { computeGalaxyStats } from "../lib/galaxy";

/**
 * Observer-mode-only stats card. In owner mode the same numbers live in
 * SidebarBody's footer instead — this standalone plaque would otherwise
 * duplicate it.
 */
export function GalaxyPlaque({
  papers,
  displayName,
}: {
  papers: PaperRecord[];
  displayName: string;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setVisible(true), 400);
    return () => window.clearTimeout(t);
  }, []);

  const stats = computeGalaxyStats(papers);

  if (!visible) return null;

  return (
    <div className="absolute left-5 top-20 z-20 rounded-2xl glass px-4 py-3 shadow-panel animate-fade-up">
      <div className="text-[13px] font-semibold text-ink">{displayName}</div>
      <div className="mt-0.5 text-[11px] text-muted tabular-nums">
        {stats.stars} stars · {stats.ignited} ignited · {stats.constellations} constellations
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-cyan-400/80">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400/70" />
        observer mode · read-only
      </div>
    </div>
  );
}
