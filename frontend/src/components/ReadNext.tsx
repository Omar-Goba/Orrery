import { useState } from "react";
import { Compass } from "lucide-react";
import clsx from "clsx";
import type { Recommendation } from "../api/client";
import { getRecommendations } from "../api/client";
import { useAsyncState } from "../hooks/useAsyncState";

// ── "What should I read next" floating widget ────────────────────────────────
export function ReadNext({
  onOpenPaperId,
}: {
  onOpenPaperId: (paperId: string) => void;
}) {
  const [open, setOpen]     = useState(false);
  const recommendations = useAsyncState<Recommendation[]>();

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    recommendations.run(getRecommendations).catch(() => undefined);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="Read next"
        title="Read next"
        className={clsx(
          "flex items-center gap-1.5 rounded-full glass px-3 py-2 shadow-panel transition-colors",
          open ? "text-violet-300" : "text-muted hover:text-violet-300"
        )}
      >
        <Compass size={15} />
        <span className="hidden sm:inline text-[11px] font-semibold">Read next</span>
      </button>

      {open && (
        <section className="absolute bottom-full right-0 mb-3 w-80 max-h-[60vh] flex flex-col overflow-hidden rounded-2xl glass shadow-panel animate-fade-up">
          <header className="shrink-0 flex items-center gap-2 border-b border-rim/60 px-3.5 py-3">
            <Compass size={13} className="text-violet-400" />
            <span className="text-[12px] font-semibold tracking-tight text-ink">Read next</span>
          </header>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
            {recommendations.loading && (
              <div className="flex items-center justify-center py-6">
                <span className="inline-flex gap-1 items-center">
                  {[0, 150, 300].map(delay => (
                    <span
                      key={delay}
                      className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </span>
              </div>
            )}

            {!recommendations.loading && recommendations.error && (
              <p className="px-1 py-4 text-center text-[11px] text-muted">
                Couldn't load recommendations.
              </p>
            )}

            {!recommendations.loading && !recommendations.error && recommendations.data && recommendations.data.length === 0 && (
              <p className="px-1 py-4 text-center text-[11px] text-muted">
                Nothing urgent — add something to your to-read pile.
              </p>
            )}

            {!recommendations.loading && !recommendations.error && recommendations.data && recommendations.data.length > 0 && (
              recommendations.data.map(rec => (
                <RecommendationCard key={rec.paper_id} rec={rec} onOpenPaperId={onOpenPaperId} />
              ))
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Recommendation card ──────────────────────────────────────────────────────
function RecommendationCard({
  rec,
  onOpenPaperId,
}: {
  rec: Recommendation;
  onOpenPaperId: (paperId: string) => void;
}) {
  const parts = rec.cluster_path?.split("/") ?? [];

  return (
    <button
      type="button"
      onClick={() => onOpenPaperId(rec.paper_id)}
      className="flex w-full flex-col items-start gap-1 bg-card border border-rim rounded-xl p-3 text-left hover:border-cyan-500/30 transition-colors group"
    >
      <p className="text-[12px] font-medium text-zinc-200 leading-snug line-clamp-2">
        {rec.title}
      </p>
      {(rec.author || rec.year) && (
        <p className="text-[11px] text-muted">
          {[rec.author, rec.year].filter(Boolean).join(" · ")}
        </p>
      )}
      {parts.length > 0 && (
        <p className="text-[10px] text-wire">
          {parts.join(" › ")}
        </p>
      )}
      <p className="text-[11px] italic text-violet-300">
        {rec.reason}
      </p>
    </button>
  );
}
