import clsx from "clsx";
import type { PaperRecord } from "../api/client";

const PALETTE_COLORS = ["#22d3ee", "#a78bfa", "#34d399", "#f59e0b"];

function clusterColor(paper: PaperRecord, papers: PaperRecord[]): string {
  const l1Names = [
    ...new Set(papers.map(p => p.cluster_path?.split("/")[0]).filter(Boolean)),
  ] as string[];
  const l1 = paper.cluster_path?.split("/")[0];
  const idx = l1 ? l1Names.indexOf(l1) : -1;
  return PALETTE_COLORS[Math.max(0, idx) % PALETTE_COLORS.length];
}

export function StarCard({
  paper: p,
  papers,
  pinned,
  isObserver,
  onToggle,
  onOpenPaper,
  onAskOracle,
}: {
  paper: PaperRecord;
  /** Full library, only used to derive the same cluster hue as ClusterLegend. */
  papers: PaperRecord[];
  /** True when the card was pinned by a click rather than a hover. */
  pinned?: boolean;
  isObserver?: boolean;
  onToggle?: (paper: PaperRecord, newStatus: "read" | "toread") => void;
  onOpenPaper?: (paper: PaperRecord) => void;
  onAskOracle?: (title: string) => void;
}) {
  const isRead = p.status === "read";
  const nextStatus = (isRead ? "toread" : "read") as "read" | "toread";
  const color = clusterColor(p, papers);
  const leaf = p.cluster_path?.split("/").pop() ?? "unclustered";

  return (
    <div
      className={clsx(
        "absolute right-5 top-24 z-20 w-[230px] rounded-2xl glass p-4 shadow-panel animate-fade-up",
        pinned && "ring-1 ring-cyan-400/30"
      )}
    >
      <p className="text-[13px] font-semibold text-ink leading-snug line-clamp-2">
        {p.title ?? p.filename.replace(/\.pdf$/i, "")}
      </p>
      {(p.author || p.year) && (
        <p className="mt-0.5 text-[11px] text-muted">
          {[p.author, p.year].filter(Boolean).join(" · ")}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
          style={{ background: `${color}22`, color }}
        >
          {leaf}
        </span>
        <span className="text-[10px] text-muted">
          {isRead ? "ignited · read" : "protostar · to-read"}
        </span>
      </div>

      {p.summary && (
        <p className="mt-2 text-[11px] text-zinc-400 leading-relaxed line-clamp-2">
          {p.summary}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onOpenPaper?.(p)}
          className="flex-1 rounded-lg bg-cyan-500/12 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-400 hover:bg-cyan-500/20 transition-colors"
        >
          Open PDF
        </button>
        <button
          onClick={() => onAskOracle?.(p.title ?? p.filename)}
          className="flex-1 rounded-lg bg-violet-500/12 px-2.5 py-1.5 text-[11px] font-semibold text-violet-400 hover:bg-violet-500/20 transition-colors"
        >
          Ask Oracle
        </button>
      </div>

      {!isObserver && onToggle && (
        <button
          onClick={() => onToggle(p, nextStatus)}
          className={clsx(
            "mt-2 w-full rounded-lg px-2.5 py-1 text-[10px] font-semibold transition-colors",
            isRead
              ? "bg-emerald-500/12 text-emerald-400 hover:bg-emerald-500/20"
              : "bg-amber-500/12 text-amber-400 hover:bg-amber-500/20"
          )}
        >
          {isRead ? "mark as to-read" : "mark as read"}
        </button>
      )}
    </div>
  );
}
