import { useState } from "react";
import { Search, FileText, ChevronRight, ExternalLink } from "lucide-react";
import clsx from "clsx";
import type { PaperRecord, SSEEvent } from "../api/client";
import { getPaperUrl, streamChat } from "../api/client";
import { useAsyncState } from "../hooks/useAsyncState";
import { useSSEStream } from "../hooks/useSSEStream";

export function Finder() {
  const [query, setQuery] = useState("");
  const results = useAsyncState<PaperRecord[]>([]);
  const [searched, setSearched] = useState(false);
  const stream = useSSEStream();
  const papers = results.data ?? [];
  const searching = results.loading;

  const search = () => {
    const q = query.trim();
    if (!q || searching) return;
    results.start([]);
    setSearched(false);

    const msg = `find_paper: ${q}`;
    let receivedResult = false;
    stream.start(() => streamChat(msg, (event: SSEEvent) => {
      if (event.type === "result") {
        receivedResult = true;
        results.succeed(event.papers);
        setSearched(true);
      } else if (event.type === "done") {
        if (!receivedResult) results.succeed([]);
        setSearched(true);
      } else if (event.type === "error") {
        results.fail(event.message);
        setSearched(true);
      }
    }));
  };

  return (
    <div className="flex flex-col h-full p-6 gap-6 max-w-2xl mx-auto w-full">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">Find a Paper</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Describe it vaguely — "the one about attention mechanisms" — and we'll find it.
        </p>
      </div>

      {/* Search bar */}
      <div className="flex gap-2 bg-zinc-800/60 rounded-xl border border-zinc-700 focus-within:border-indigo-500 transition-colors">
        <div className="pl-4 flex items-center">
          <Search size={16} className={clsx(searching ? "text-indigo-400 animate-pulse" : "text-zinc-600")} />
        </div>
        <input
          className="flex-1 bg-transparent px-3 py-3 text-sm text-zinc-200 placeholder-zinc-600 outline-none"
          placeholder="e.g. that paper about RLHF for robotics…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          disabled={searching}
        />
        <button
          onClick={search}
          disabled={searching || !query.trim()}
          className={clsx(
            "m-1.5 px-4 rounded-lg text-sm font-medium transition-all",
            query.trim() && !searching
              ? "bg-indigo-600 hover:bg-indigo-500 text-white"
              : "bg-zinc-700 text-zinc-500 cursor-not-allowed"
          )}
        >
          Search
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto space-y-3">
        {searching && (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-zinc-600">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm">Searching library…</p>
          </div>
        )}

        {searched && papers.length === 0 && !searching && (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-zinc-600">
            <Search size={32} />
            <p className="text-sm">No results found. Try different keywords.</p>
          </div>
        )}

        {papers.map((paper) => (
          <PaperCard key={paper.id} paper={paper} />
        ))}
      </div>
    </div>
  );
}

function PaperCard({ paper }: { paper: PaperRecord }) {
  const clusterParts = paper.cluster_path?.split("/") ?? [];
  return (
    <div className="bg-zinc-800/50 border border-zinc-700/60 rounded-xl p-4 hover:border-zinc-600 transition-colors">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-zinc-700 flex items-center justify-center mt-0.5">
          <FileText size={16} className="text-zinc-400" />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-zinc-100 text-sm font-medium leading-snug">
            {paper.title || paper.filename.replace(/\.pdf$/, "")}
          </p>
          {(paper.author || paper.year) && (
            <p className="text-zinc-500 text-xs">
              {[paper.author, paper.year].filter(Boolean).join(" · ")}
            </p>
          )}
          {clusterParts.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {clusterParts.map((part, i) => (
                <span key={i} className="flex items-center gap-1 text-xs text-zinc-600">
                  <span className="text-zinc-500">{part.replace(/_/g, " ")}</span>
                  {i < clusterParts.length - 1 && <ChevronRight size={10} />}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <span
            className={clsx(
              "text-[10px] px-2 py-0.5 rounded font-medium",
              paper.status === "read"
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-amber-500/15 text-amber-400"
            )}
          >
            {paper.status === "read" ? "read" : "to-read"}
          </span>
          <a
            href={getPaperUrl(paper.id)}
            target="_blank"
            rel="noreferrer"
            className="p-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 transition-colors"
          >
            <ExternalLink size={13} className="text-zinc-400" />
          </a>
        </div>
      </div>
    </div>
  );
}
