import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, RefreshCw, FolderTree, Network, MessageSquare, ScanSearch } from "lucide-react";
import clsx from "clsx";
import { TreeView } from "./components/TreeView";
import { PaperGraph } from "./components/PaperGraph";
import { AgentPortal } from "./components/AgentPortal";
import { PdfReader } from "./components/PdfReader";
import type { PaperRecord, TreeNode } from "./api/client";
import { getPaperUrl, getTree, listPapers, setPaperStatus, streamReindex } from "./api/client";

type MobileView = "tree" | "graph" | "chat";

const PALETTE_COLORS = [
  "#22d3ee", "#a78bfa", "#34d399", "#f59e0b",
];

export default function App() {
  const [tree, setTree]              = useState<TreeNode | null>(null);
  const [papers, setPapers]          = useState<PaperRecord[]>([]);
  const [hovered, setHovered]        = useState<PaperRecord | null>(null);
  const [activePaper, setActivePaper] = useState<PaperRecord | null>(null);
  const [refreshing, setRefresh]     = useState(false);
  const [mobileView, setMobile]      = useState<MobileView>("chat");
  const [reindexing, setReindexing]  = useState(false);
  const [reindexStep, setReindexStep] = useState("");
  const [reindexPct, setReindexPct]  = useState(0);
  const abortReindex                 = useRef<(() => void) | null>(null);

  const load = async () => {
    try {
      const [t, p] = await Promise.all([getTree(), listPapers()]);
      setTree(t);
      setPapers(p);
    } catch {
      setTree(null);
    }
  };

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, []);

  const refresh = async () => {
    setRefresh(true);
    await load();
    setRefresh(false);
  };

  const startReindex = useCallback(() => {
    if (reindexing) return;
    setReindexing(true);
    setReindexPct(0);
    setReindexStep("Starting…");
    abortReindex.current = streamReindex((ev) => {
      if (ev.type === "progress") {
        setReindexStep(ev.step);
        setReindexPct(ev.pct);
      } else if (ev.type === "done" || ev.type === "error") {
        setReindexing(false);
        setReindexStep("");
        setReindexPct(0);
        load();
      }
    });
  }, [reindexing]);

  const toggleStatus = useCallback(async (paper: PaperRecord, newStatus: "read" | "toread") => {
    const updated = await setPaperStatus(paper.id, newStatus);
    setActivePaper(current => current?.id === updated.id ? updated : current);
    await load();
  }, []);

  const openPaper = useCallback((paper: PaperRecord) => {
    setActivePaper(paper);
  }, []);

  const openPaperById = useCallback((paperId: string) => {
    const paper = papers.find(p => p.id === paperId);
    if (paper) setActivePaper(paper);
    else window.open(getPaperUrl(paperId), "_blank");
  }, [papers]);

  const readCount   = papers.filter(p => p.status === "read").length;
  const toreadCount = papers.filter(p => p.status === "toread").length;

  return (
    <div className="h-[100dvh] overflow-hidden bg-bg text-ink dark select-none">

      {/* ══════════════════════════════════════════════════════════════════
          DESKTOP  (lg +)  —  three columns
      ══════════════════════════════════════════════════════════════════ */}
      <div className="hidden lg:flex w-full h-full">

        {/* Left sidebar */}
        <aside className="w-64 shrink-0 flex flex-col border-r border-rim overflow-hidden">
          <SidebarHeader
            refreshing={refreshing} onRefresh={refresh}
            reindexing={reindexing} onReindex={startReindex}
            reindexStep={reindexStep} reindexPct={reindexPct}
          />
          <SidebarBody tree={tree} readCount={readCount} toreadCount={toreadCount} onOpenPaperId={openPaperById} />
        </aside>

        {/* Center graph */}
        <main className="flex-1 relative overflow-hidden bg-bg min-w-0">
          {activePaper ? (
            <PdfReader
              key={activePaper.id}
              paper={activePaper}
              mode="desktop"
              onClose={() => setActivePaper(null)}
              onToggleStatus={toggleStatus}
            />
          ) : (
            <>
              <PaperGraph papers={papers} onHover={setHovered} onOpenPaper={openPaper} />
              <ClusterLegend papers={papers} />
              {hovered && <HoverBar paper={hovered} onToggle={toggleStatus} onOpenPaper={openPaper} />}
              {papers.length === 0 && !refreshing && <GraphEmptyState />}
            </>
          )}
        </main>

        {/* Right agent portal */}
        <aside className="w-80 xl:w-96 shrink-0 border-l border-rim flex flex-col bg-surface overflow-hidden">
          <AgentPortal onUploadDone={refresh} onOpenPaper={openPaper} onOpenPaperId={openPaperById} />
        </aside>
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          MOBILE  (< lg)  —  single panel + bottom nav
      ══════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-col w-full h-full lg:hidden">

        {/* Mobile header */}
        <SidebarHeader
          refreshing={refreshing} onRefresh={refresh}
          reindexing={reindexing} onReindex={startReindex}
          reindexStep={reindexStep} reindexPct={reindexPct}
        />

        {/* Panels — always rendered, shown/hidden via CSS to preserve state */}
        <div className="flex-1 overflow-hidden relative min-h-0">

          {/* Tree panel */}
          <div
            className={clsx(
              "absolute inset-0 overflow-y-auto transition-opacity duration-200",
              mobileView === "tree" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
            )}
          >
          <SidebarBody tree={tree} readCount={readCount} toreadCount={toreadCount} onOpenPaperId={openPaperById} />
          </div>

          {/* Graph panel */}
          <div
            className={clsx(
              "absolute inset-0 transition-opacity duration-200",
              mobileView === "graph" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
            )}
          >
            <PaperGraph papers={papers} onHover={setHovered} onOpenPaper={openPaper} active={mobileView === "graph"} />
            <ClusterLegend papers={papers} />
            {hovered && mobileView === "graph" && <HoverBar paper={hovered} onOpenPaper={openPaper} />}
          </div>

          {/* Chat panel */}
          <div
            className={clsx(
              "absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200",
              mobileView === "chat" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
            )}
          >
            <AgentPortal onUploadDone={refresh} onOpenPaper={openPaper} onOpenPaperId={openPaperById} hideHeader />
          </div>
        </div>

        {activePaper && (
          <PdfReader
            key={activePaper.id}
            paper={activePaper}
            mode="mobile"
            onClose={() => setActivePaper(null)}
            onToggleStatus={toggleStatus}
          />
        )}

        {/* Bottom navigation */}
        <nav className="shrink-0 flex border-t border-rim bg-surface pb-safe">
          {(
            [
              { id: "tree",  label: "Library",  Icon: FolderTree    },
              { id: "graph", label: "Network",  Icon: Network       },
              { id: "chat",  label: "Ask",      Icon: MessageSquare },
            ] as { id: MobileView; label: string; Icon: typeof FolderTree }[]
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setMobile(id)}
              className={clsx(
                "flex-1 flex flex-col items-center gap-1 py-3 text-[11px] font-medium transition-all",
                mobileView === id ? "text-cyan-400" : "text-muted"
              )}
            >
              <Icon size={20} strokeWidth={1.6} />
              {label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

// ── Shared sidebar header ─────────────────────────────────────────────────────
function SidebarHeader({
  refreshing,
  onRefresh,
  reindexing,
  onReindex,
  reindexStep,
  reindexPct,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  reindexing: boolean;
  onReindex: () => void;
  reindexStep: string;
  reindexPct: number;
}) {
  return (
    <div className="shrink-0 border-b border-rim">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center">
          <BookOpen size={14} className="text-cyan-400" />
        </div>
        <span className="text-[13px] font-semibold text-ink tracking-tight">The Library</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onReindex}
            disabled={reindexing}
            title="Re-cluster entire library"
            className="p-1.5 rounded-lg hover:bg-rim transition-colors disabled:opacity-40"
          >
            <ScanSearch
              size={12}
              className={clsx("transition-colors", reindexing ? "text-violet-400 animate-pulse" : "text-muted")}
            />
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh"
            className="p-1.5 rounded-lg hover:bg-rim transition-colors disabled:opacity-40"
          >
            <RefreshCw
              size={12}
              className={clsx("transition-colors", refreshing ? "text-cyan-400 animate-spin-slow" : "text-muted")}
            />
          </button>
        </div>
      </div>

      {/* Reindex progress bar */}
      {reindexing && (
        <div className="px-4 pb-3 space-y-1.5">
          <div className="flex justify-between text-[10px]">
            <span className="text-violet-400 truncate">{reindexStep}</span>
            <span className="text-muted tabular-nums shrink-0 ml-2">{reindexPct}%</span>
          </div>
          <div className="h-0.5 bg-rim rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-600 to-violet-400 transition-all duration-500"
              style={{ width: `${reindexPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared sidebar body ───────────────────────────────────────────────────────
function SidebarBody({
  tree,
  readCount,
  toreadCount,
  onOpenPaperId,
}: {
  tree: TreeNode | null;
  readCount: number;
  toreadCount: number;
  onOpenPaperId?: (paperId: string) => void;
}) {
  return (
    <>
      <div className="shrink-0 px-4 pt-3 pb-1">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-muted">
          Semantic Tree
        </span>
      </div>
      <div className="flex-1 overflow-y-auto pb-2 min-h-0">
        {tree ? (
          <TreeView node={tree} depth={0} onOpenPaperId={onOpenPaperId} />
        ) : (
          <div className="px-4 py-6 text-center text-[11px] text-muted">Loading…</div>
        )}
      </div>
      <div className="shrink-0 px-4 py-3 border-t border-rim flex items-center gap-4">
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80" />
          {readCount} read
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80" />
          {toreadCount} to-read
        </span>
      </div>
    </>
  );
}

// ── Graph empty state ─────────────────────────────────────────────────────────
function GraphEmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
      <BookOpen size={36} className="text-rim" />
      <p className="text-[13px] text-muted text-center px-4">
        Upload papers using the Agent Portal
      </p>
    </div>
  );
}

// ── Hover info bar (bottom of graph) ─────────────────────────────────────────
function HoverBar({
  paper: p,
  onToggle,
  onOpenPaper,
}: {
  paper: PaperRecord;
  onToggle?: (paper: PaperRecord, newStatus: "read" | "toread") => void;
  onOpenPaper?: (paper: PaperRecord) => void;
}) {
  const isRead     = p.status === "read";
  const nextStatus = (isRead ? "toread" : "read") as "read" | "toread";

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2.5 bg-surface/90 backdrop-blur-sm border border-rim rounded-2xl px-3.5 py-2 shadow-panel max-w-[calc(100%-2rem)]">
      <span className="text-[12px] font-medium text-zinc-200 truncate max-w-[180px] sm:max-w-[260px] lg:max-w-[320px]">
        {p.title ?? p.filename.replace(/\.pdf$/i, "")}
      </span>
      <span className="hidden sm:inline text-[11px] text-muted shrink-0">
        {[p.author, p.year].filter(Boolean).join(" · ")}
      </span>
      <button
        onClick={() => onOpenPaper?.(p)}
        className="shrink-0 text-[10px] px-2 py-0.5 rounded-md bg-cyan-500/12 text-cyan-400 font-semibold hover:bg-cyan-500/20 transition-colors"
      >
        open
      </button>
      <button
        onClick={() => onToggle?.(p, nextStatus)}
        title={isRead ? "Mark as to-read" : "Mark as read"}
        className={clsx(
          "shrink-0 text-[9px] px-1.5 py-0.5 rounded font-semibold transition-all hover:scale-105 active:scale-95",
          isRead
            ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
            : "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
        )}
      >
        {isRead ? "read" : "to-read"}
      </button>
    </div>
  );
}

// ── Cluster color legend ──────────────────────────────────────────────────────
function ClusterLegend({ papers }: { papers: PaperRecord[] }) {
  const l1Names = [
    ...new Set(papers.map(p => p.cluster_path?.split("/")[0]).filter(Boolean)),
  ] as string[];
  if (!l1Names.length) return null;

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1.5 pointer-events-none">
      {l1Names.map((name, i) => {
        const color = PALETTE_COLORS[i % PALETTE_COLORS.length];
        const count = papers.filter(p => p.cluster_path?.startsWith(name)).length;
        return (
          <div key={name} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: color, boxShadow: `0 0 6px ${color}88` }}
            />
            <span className="text-[11px] text-muted max-w-[110px] truncate leading-none">{name}</span>
            <span className="text-[10px] text-wire tabular-nums">{count}</span>
          </div>
        );
      })}
    </div>
  );
}
