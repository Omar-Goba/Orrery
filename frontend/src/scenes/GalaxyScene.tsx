import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, RefreshCw, FolderTree, Network, MessageSquare, PanelLeftClose, ScanSearch, Search, HardDrive } from "lucide-react";
import clsx from "clsx";
import { TreeView } from "../components/TreeView";
import { PaperGraph, type IngestOrbHandle, type PaperGraphHandle } from "../components/PaperGraph";
import { AgentPortal } from "../components/AgentPortal";
import { PdfReader } from "../components/PdfReader";
import { ReadNext } from "../components/ReadNext";
import { StarCard } from "../components/StarCard";
import { GalaxyPlaque } from "../components/GalaxyPlaque";
import { TourController } from "../components/TourController";
import { computeGalaxyStats } from "../lib/galaxy";
import type { ApiMode, PaperRecord, SimilarityGraph, StoredFileEntry, TreeNode, VoyagerStorageSummary } from "../api/client";
import {
  formatBytes, getPaperUrl, getSimilarityGraph, getTree, listKeeperVoyagerFiles, listKeeperVoyagers, listPapers, setPaperStatus, streamReindex,
} from "../api/client";
import { OWNER_USERNAME } from "../auth/session";
import type { GalaxyMode, Session } from "../auth/session";

type MobileView = "tree" | "graph" | "chat";
type PaperStatus = "read" | "toread";

const PALETTE_COLORS = [
  "#22d3ee", "#a78bfa", "#34d399", "#f59e0b",
];

export function GalaxyScene({
  galaxy,
  mode,
  session,
  onExitToUniverse,
  onLogout,
  initialView,
}: {
  galaxy: string;
  mode: GalaxyMode;
  session: Session | null;
  /** Keep session, return to the universe map. */
  onExitToUniverse: () => void;
  /** Owner-only: clear session and return to the universe map. */
  onLogout?: () => void;
  /** Arrival dolly after a warp — starts zoomed out and glides to k=1. */
  initialView?: { k: number };
}) {
  const [tree, setTree]              = useState<TreeNode | null>(null);
  const [papers, setPapers]          = useState<PaperRecord[]>([]);
  const [hovered, setHovered]        = useState<PaperRecord | null>(null);
  const [pinnedPaper, setPinnedPaper] = useState<PaperRecord | null>(null);
  const [activePaper, setActivePaper] = useState<PaperRecord | null>(null);
  const [refreshing, setRefresh]     = useState(false);
  const [mobileView, setMobile]      = useState<MobileView>("chat");
  const [reindexing, setReindexing]  = useState(false);
  const [reindexStep, setReindexStep] = useState("");
  const [reindexPct, setReindexPct]  = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [similarity, setSimilarity]  = useState<SimilarityGraph>({});
  const [focusPath, setFocusPath]    = useState<string | null>(null);
  const [oraclePrefill, setOraclePrefill] = useState<{ text: string; token: number } | null>(null);
  const [tourHighlightPath, setTourHighlightPath] = useState<string | null>(null);
  const [desktopViewport, setDesktopViewport] = useState(() =>
    window.matchMedia?.("(min-width: 1024px)").matches ?? window.innerWidth >= 1024
  );
  const abortReindex                 = useRef<(() => void) | null>(null);
  const graphRef    = useRef<PaperGraphHandle>(null);
  const focusTokenRef = useRef(0);
  const oracleTokenRef = useRef(0);
  const ingestOrbRef = useRef<IngestOrbHandle | null>(null);

  // Owner mode always reads the authenticated user's own galaxy. Observer mode
  // only has one public target: Omar's Keeper tour.
  const hasRealData = mode === "owner" || galaxy === OWNER_USERNAME;
  const apiMode: ApiMode = mode === "observer" ? "tour" : "normal";

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => setDesktopViewport(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const load = useCallback(async () => {
    if (!hasRealData) {
      setTree(null);
      setPapers([]);
      return;
    }
    try {
      const [t, p] = await Promise.all([getTree(apiMode), listPapers(apiMode)]);
      setTree(t);
      setPapers(p);
    } catch {
      setTree(null);
      setPapers([]);
    }
    try {
      setSimilarity(await getSimilarityGraph(apiMode));
    } catch {
      // Real-embedding constellation edges are an enhancement, not required —
      // ignore failures so a missing/older backend doesn't break the graph.
    }
  }, [apiMode, hasRealData]);

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);

  const refresh = async () => {
    setRefresh(true);
    await load();
    setRefresh(false);
  };

  const startReindex = useCallback(() => {
    if (reindexing) return;
    const confirmed = window.confirm(
      "Reindex the whole library? This reclusters papers and may take a while."
    );
    if (!confirmed) return;
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
  }, [reindexing, load]);

  const toggleStatus = useCallback(async (paper: PaperRecord, newStatus: PaperStatus) => {
    const updated = await setPaperStatus(paper.id, newStatus);
    setPapers(current => current.map(p => p.id === updated.id ? updated : p));
    setActivePaper(current => current?.id === updated.id ? updated : current);
    setHovered(current => current?.id === updated.id ? updated : current);
    setPinnedPaper(current => current?.id === updated.id ? updated : current);
    setTree(current => current ? patchTreeStatus(current, updated.id, updated.status) : current);
    if (newStatus === "read") graphRef.current?.igniteStar(paper.id);
  }, []);

  const openPaper = useCallback((paper: PaperRecord) => {
    setActivePaper(paper);
  }, []);

  const openPaperById = useCallback((paperId: string) => {
    const paper = papers.find(p => p.id === paperId);
    if (paper) setActivePaper(paper);
    else window.open(getPaperUrl(paperId, apiMode), "_blank");
  }, [apiMode, papers]);

  // Desktop graph click: pin the StarCard instead of opening the reader
  // directly — one more click to open, but far less jumpy for observers.
  const pinStar = useCallback((paper: PaperRecord) => {
    setPinnedPaper(current => current?.id === paper.id ? null : paper);
  }, []);

  const askOracle = useCallback((title: string) => {
    oracleTokenRef.current++;
    setOraclePrefill({ text: `About "${title}": `, token: oracleTokenRef.current });
  }, []);

  const handleCitations = useCallback((paperIds: string[]) => {
    graphRef.current?.pulseCitations(paperIds);
  }, []);

  const handleUploadStart = useCallback((seed: string) => {
    ingestOrbRef.current?.cancel();
    ingestOrbRef.current = graphRef.current?.spawnIngestOrb(seed) ?? null;
  }, []);

  const handleUploadProgress = useCallback((progress: { step: string; pct: number }) => {
    ingestOrbRef.current?.update(progress);
  }, []);

  const handleUploadResolve = useCallback((paper: PaperRecord) => {
    ingestOrbRef.current?.resolve(paper);
  }, []);

  const handleUploadCancel = useCallback(() => {
    ingestOrbRef.current?.cancel();
    ingestOrbRef.current = null;
  }, []);

  useEffect(() => () => {
    ingestOrbRef.current?.cancel();
    ingestOrbRef.current = null;
  }, []);

  const handleFocusCluster = useCallback((path: string) => {
    setLibraryOpen(true);
    setFocusPath(path);
    // Use a generation token rather than comparing path strings — repeat clicks on the
    // same cluster would otherwise let a stale timeout clear a highlight a newer click just set.
    const token = ++focusTokenRef.current;
    window.setTimeout(() => {
      if (focusTokenRef.current === token) setFocusPath(null);
    }, 2400);
  }, []);

  const readCount   = papers.filter(p => p.status === "read").length;
  const toreadCount = papers.filter(p => p.status === "toread").length;
  const constellations = computeGalaxyStats(papers).constellations;
  // Observer gating is cosmetic until real auth lands — the API remains open.
  const isObserver  = mode === "observer";
  const showStorageLedger = !isObserver && session?.role === "keeper";

  return (
    <div className="h-[100dvh] overflow-hidden bg-bg text-ink dark">

      {/* Ambient aurora — sits behind the graph canvas */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 h-[520px] w-[520px] rounded-full bg-cyan-500/[0.06] blur-[120px]" />
        <div className="absolute -bottom-48 -right-24 h-[560px] w-[560px] rounded-full bg-violet-500/[0.06] blur-[130px]" />
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          DESKTOP  (lg +)  —  full-bleed graph + floating glass panels
      ══════════════════════════════════════════════════════════════════ */}
      <div className="hidden lg:block relative w-full h-full">

        {/* The universe */}
        <PaperGraph
          ref={graphRef}
          papers={papers}
          active={desktopViewport}
          onHover={setHovered}
          onOpenPaper={pinStar}
          insets={{ left: libraryOpen ? 380 : 120, right: 100, top: 90, bottom: 150 }}
          similarity={similarity}
          onFocusCluster={handleFocusCluster}
          initialView={initialView}
          highlightPath={tourHighlightPath}
          selectedPaperId={pinnedPaper?.id ?? activePaper?.id}
        />
        <ClusterLegend papers={papers} />
        {!libraryOpen && isObserver && (
          <GalaxyPlaque
            papers={papers}
            displayName={galaxy === OWNER_USERNAME ? "Omar's galaxy" : `${galaxy}'s galaxy`}
          />
        )}
        {showStorageLedger && <StorageLedger />}
        {(pinnedPaper ?? hovered) && !activePaper && (
          <StarCard
            paper={(pinnedPaper ?? hovered)!}
            papers={papers}
            pinned={!!pinnedPaper}
            isObserver={isObserver}
            onToggle={toggleStatus}
            onOpenPaper={openPaper}
            onAskOracle={askOracle}
          />
        )}
        {papers.length === 0 && !refreshing && (
          <GraphEmptyState hasRealData={hasRealData} onVisitOwner={onExitToUniverse} />
        )}

        {/* Floating library panel */}
        {libraryOpen ? (
          <aside className="absolute left-5 top-5 bottom-5 z-20 flex w-[300px] flex-col overflow-hidden rounded-2xl glass shadow-panel animate-fade-up">
            <SidebarHeader
              refreshing={refreshing} onRefresh={refresh}
              reindexing={reindexing} onReindex={startReindex}
              reindexStep={reindexStep} reindexPct={reindexPct}
              showProgress={false}
              onCollapse={() => setLibraryOpen(false)}
              isObserver={isObserver}
              onExitToUniverse={onExitToUniverse}
              onLogout={onLogout}
            />
            <SidebarBody
              tree={tree} readCount={readCount} toreadCount={toreadCount}
              constellations={constellations} isObserver={isObserver}
              onOpenPaperId={openPaperById} focusPath={focusPath}
            />
          </aside>
        ) : (
          <button
            onClick={() => setLibraryOpen(true)}
            aria-label="Open library panel"
            title="Open library panel"
            className="absolute left-5 top-5 z-20 rounded-xl glass p-3 text-cyan-400 shadow-panel transition-colors hover:text-cyan-300"
          >
            <BookOpen size={16} />
          </button>
        )}

        {/* Reindex progress toast */}
        {reindexing && (
          <div className="absolute top-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full glass px-4 py-2 shadow-panel animate-fade-up">
            <ScanSearch size={13} className="shrink-0 text-violet-400 animate-pulse" />
            <span className="max-w-[220px] truncate text-[11px] text-zinc-300">{reindexStep}</span>
            <div className="h-1 w-24 overflow-hidden rounded-full bg-rim">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-600 to-violet-400 transition-all duration-500"
                style={{ width: `${reindexPct}%` }}
              />
            </div>
            <span className="text-[10px] text-muted tabular-nums">{reindexPct}%</span>
          </div>
        )}

        {/* Floating omnibar + conversation sheet — Oracle chat stays available
            to observers (it answers from the indexed corpus); uploads don't. */}
        <AgentPortal
          variant="float"
          onUploadDone={refresh}
          onOpenPaper={openPaper}
          onOpenPaperId={openPaperById}
          onCitations={handleCitations}
          onUploadStart={handleUploadStart}
          onUploadProgress={handleUploadProgress}
          onUploadResolve={handleUploadResolve}
          onUploadCancel={handleUploadCancel}
          apiMode={apiMode}
          disableUpload={isObserver}
          prefill={oraclePrefill ?? undefined}
        />

        {/* Autopilot tour — desktop only; both modes get the invitation */}
        <TourController
          papers={papers}
          graphRef={graphRef}
          suppressStart={!!activePaper}
          onHighlightPath={setTourHighlightPath}
        />

        {/* Read-next recommendations — a personal queue, meaningless to guests */}
        {!isObserver && (
          <div className="absolute bottom-5 right-5 z-20">
            <ReadNext onOpenPaperId={openPaperById} />
          </div>
        )}

        {/* Reader overlay */}
        {activePaper && (
          <div className="absolute inset-0 z-40 bg-bg/60 p-5 backdrop-blur-sm">
            <div className="h-full overflow-hidden rounded-2xl border border-rim shadow-panel animate-fade-up">
              <PdfReader
                key={activePaper.id}
                paper={activePaper}
                mode="desktop"
                apiMode={apiMode}
                onClose={() => setActivePaper(null)}
                onToggleStatus={isObserver ? undefined : toggleStatus}
              />
            </div>
          </div>
        )}
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
          isObserver={isObserver}
          onExitToUniverse={onExitToUniverse}
          onLogout={onLogout}
        />

        {showStorageLedger && (
          <div className="shrink-0 border-b border-rim bg-surface/75 px-3 py-3">
            <StorageLedger compact />
          </div>
        )}

        {/* Panels — always rendered, shown/hidden via CSS to preserve state */}
        <div className="flex-1 overflow-hidden relative min-h-0">

          {/* Tree panel */}
          <div
            className={clsx(
              "absolute inset-0 overflow-y-auto transition-opacity duration-200",
              mobileView === "tree" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
            )}
            aria-hidden={mobileView !== "tree"}
          >
            <SidebarBody
              tree={tree} readCount={readCount} toreadCount={toreadCount}
              constellations={constellations} isObserver={isObserver}
              onOpenPaperId={openPaperById}
            />
          </div>

          {/* Graph panel */}
          <div
            className={clsx(
              "absolute inset-0 transition-opacity duration-200",
              mobileView === "graph" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
            )}
            aria-hidden={mobileView !== "graph"}
          >
            <PaperGraph
              papers={papers}
              onHover={setHovered}
              onOpenPaper={openPaper}
              active={!desktopViewport && mobileView === "graph"}
              insets={{ left: 30, right: 30, top: 80, bottom: 90 }}
              similarity={similarity}
              selectedPaperId={activePaper?.id}
            />
            <ClusterLegend papers={papers} />
            {hovered && mobileView === "graph" && <HoverBar paper={hovered} onOpenPaper={openPaper} />}
          </div>

          {/* Chat panel */}
          <div
            className={clsx(
              "absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200",
              mobileView === "chat" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
            )}
            aria-hidden={mobileView !== "chat"}
          >
            <AgentPortal
              onUploadDone={refresh} onOpenPaper={openPaper} onOpenPaperId={openPaperById}
              hideHeader apiMode={apiMode} disableUpload={isObserver} prefill={oraclePrefill ?? undefined}
            />
          </div>
        </div>

        {activePaper && (
          <PdfReader
            key={activePaper.id}
            paper={activePaper}
            mode="mobile"
            apiMode={apiMode}
            onClose={() => setActivePaper(null)}
            onToggleStatus={isObserver ? undefined : toggleStatus}
          />
        )}

        {/* Bottom navigation */}
        <nav className="shrink-0 flex border-t border-rim bg-surface/85 backdrop-blur-xl pb-safe">
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
              aria-current={mobileView === id ? "page" : undefined}
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
  showProgress = true,
  onCollapse,
  isObserver,
  onExitToUniverse,
  onLogout,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  reindexing: boolean;
  onReindex: () => void;
  reindexStep: string;
  reindexPct: number;
  showProgress?: boolean;
  onCollapse?: () => void;
  isObserver?: boolean;
  onExitToUniverse?: () => void;
  onLogout?: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-rim">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center">
          <BookOpen size={14} className="text-cyan-400" />
        </div>
        <span className="text-sm font-semibold text-ink tracking-tight">orrery</span>
        <div className="ml-auto flex items-center gap-1">
          {!isObserver && (
            <button
              onClick={onReindex}
              disabled={reindexing}
              aria-label="Reindex library"
              title="Reindex library"
              className="p-1.5 rounded-lg hover:bg-rim transition-colors disabled:opacity-40"
            >
              <ScanSearch
                size={12}
                className={clsx("transition-colors", reindexing ? "text-violet-400 animate-pulse" : "text-muted")}
              />
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh library"
            title="Refresh"
            className="p-1.5 rounded-lg hover:bg-rim transition-colors disabled:opacity-40"
          >
            <RefreshCw
              size={12}
              className={clsx("transition-colors", refreshing ? "text-cyan-400 animate-spin-slow" : "text-muted")}
            />
          </button>
          {onExitToUniverse && (
            <button
              onClick={onExitToUniverse}
              aria-label="Exit to universe"
              title="Exit to universe"
              className="p-1.5 rounded-lg hover:bg-rim transition-colors text-muted text-[10px] font-semibold"
            >
              exit
            </button>
          )}
          {!isObserver && onLogout && (
            <button
              onClick={onLogout}
              aria-label="Leave galaxy"
              title="Leave galaxy"
              className="p-1.5 rounded-lg hover:bg-rim transition-colors text-muted text-[10px] font-semibold"
            >
              leave
            </button>
          )}
          {onCollapse && (
            <button
              onClick={onCollapse}
              aria-label="Collapse library panel"
              title="Collapse library panel"
              className="p-1.5 rounded-lg hover:bg-rim transition-colors"
            >
              <PanelLeftClose size={12} className="text-muted" />
            </button>
          )}
        </div>
      </div>

      {/* Reindex progress bar */}
      {showProgress && reindexing && (
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
  constellations,
  isObserver,
  onOpenPaperId,
  focusPath,
}: {
  tree: TreeNode | null;
  readCount: number;
  toreadCount: number;
  /** Shown alongside the read/to-read pills only in observer mode — the
      standalone GalaxyPlaque covers this when the sidebar is collapsed. */
  constellations?: number;
  isObserver?: boolean;
  onOpenPaperId?: (paperId: string) => void;
  focusPath?: string | null;
}) {
  const [treeQuery, setTreeQuery] = useState("");

  return (
    <>
      <div className="shrink-0 px-4 pt-3 pb-1">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-muted">
          Semantic Tree
        </span>
      </div>
      <div className="shrink-0 px-4 py-2">
        <div className="flex items-center gap-2 rounded-lg border border-rim bg-bg/60 px-2.5 py-1.5 focus-within:border-cyan-500/40">
          <Search size={12} className="shrink-0 text-wire" />
          <input
            value={treeQuery}
            onChange={e => setTreeQuery(e.target.value)}
            placeholder="Search titles, authors..."
            className="w-full bg-transparent text-[12px] text-ink placeholder:text-muted outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pb-2 min-h-0">
        {tree ? (
          <TreeView node={tree} depth={0} onOpenPaperId={onOpenPaperId} searchQuery={treeQuery} focusPath={focusPath} />
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
        {isObserver && constellations != null && (
          <span className="text-[11px] text-muted">{constellations} constellations</span>
        )}
      </div>
    </>
  );
}

function patchTreeStatus(node: TreeNode, paperId: string, status: PaperStatus): TreeNode {
  if (node.type === "paper" && node.paper_id === paperId) return { ...node, status };
  if (!node.children?.length) return node;
  let changed = false;
  const children = node.children.map(child => {
    const patched = patchTreeStatus(child, paperId, status);
    if (patched !== child) changed = true;
    return patched;
  });
  return changed ? { ...node, children } : node;
}

function StorageLedger({ compact = false }: { compact?: boolean }) {
  const [voyagers, setVoyagers] = useState<VoyagerStorageSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<StoredFileEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    listKeeperVoyagers()
      .then(rows => {
        if (cancelled) return;
        setVoyagers(rows);
        setSelected(current => current ?? rows[0]?.handle ?? null);
      })
      .catch(() => {
        if (!cancelled) setVoyagers([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    listKeeperVoyagerFiles(selected)
      .then(rows => { if (!cancelled) setFiles(rows); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [selected]);

  const selectedSummary = voyagers.find(v => v.handle === selected) ?? null;

  return (
    <section className={clsx(
      "z-20 rounded-2xl border border-rim bg-surface/85 shadow-panel backdrop-blur-xl",
      compact ? "max-h-[32dvh] overflow-hidden" : "absolute right-5 top-20 w-[340px] overflow-hidden"
    )}>
      <header className="flex items-center gap-2 border-b border-rim/70 px-3.5 py-3">
        <HardDrive size={14} className="text-cyan-400" />
        <div>
          <p className="text-[12px] font-semibold text-ink">Storage Ledger</p>
          <p className="text-[10px] text-muted">Voyager file metadata only</p>
        </div>
      </header>
      <div className={clsx("grid gap-3 p-3", compact ? "grid-cols-1" : "") }>
        <div className="space-y-2">
          {voyagers.length === 0 ? (
            <p className="rounded-xl border border-rim bg-bg/50 px-3 py-3 text-[11px] text-muted">No voyagers yet.</p>
          ) : voyagers.map(voyager => {
            const pct = voyager.storage_quota_bytes > 0
              ? Math.min(100, (voyager.storage_used_bytes / voyager.storage_quota_bytes) * 100)
              : 0;
            return (
              <button
                key={voyager.handle}
                onClick={() => setSelected(voyager.handle)}
                className={clsx(
                  "w-full rounded-xl border px-3 py-2 text-left transition-colors",
                  selected === voyager.handle
                    ? "border-cyan-400/40 bg-cyan-500/10"
                    : "border-rim bg-bg/50 hover:border-wire"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-zinc-200">{voyager.display_name}</span>
                  <span className="shrink-0 text-[10px] text-muted">{voyager.paper_count} files</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rim">
                  <div className="h-full rounded-full bg-gradient-to-r from-cyan-600 to-cyan-400" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1.5 text-[10px] text-muted">
                  {formatBytes(voyager.storage_used_bytes)} / {formatBytes(voyager.storage_quota_bytes)}
                  {voyager.disabled ? " · disabled" : ""}
                </p>
              </button>
            );
          })}
        </div>
        {selectedSummary && (
          <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
            {files.length === 0 ? (
              <p className="rounded-xl border border-rim bg-bg/50 px-3 py-3 text-[11px] text-muted">No stored PDFs.</p>
            ) : files.map(file => (
              <div key={file.paper_id} className="rounded-lg border border-rim bg-bg/45 px-2.5 py-2">
                <p className="truncate text-[11px] font-medium text-zinc-300">{file.filename}</p>
                <p className="mt-0.5 text-[10px] text-muted">
                  {formatBytes(file.size_bytes)} · {new Date(file.uploaded_at).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Graph empty state ─────────────────────────────────────────────────────────
function GraphEmptyState({
  hasRealData,
  onVisitOwner,
}: {
  hasRealData: boolean;
  onVisitOwner: () => void;
}) {
  if (!hasRealData) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
        <BookOpen size={36} className="text-rim" />
        <p className="text-sm text-muted text-center px-4">
          Your galaxy is dark.<br />
          Ignite your first star — uploads open soon for new universes.
        </p>
        <button
          onClick={onVisitOwner}
          className="pointer-events-auto rounded-lg bg-cyan-500/15 px-3 py-1.5 text-[12px] font-semibold text-cyan-400 hover:bg-cyan-500/25 transition-colors"
        >
          Visit Omar's galaxy →
        </button>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
      <BookOpen size={36} className="text-rim" />
      <p className="text-sm text-muted text-center px-4">
        Drop a PDF anywhere — or ask the portal below — to start your library.
      </p>
    </div>
  );
}

// ── Hover info bar (bottom of graph) ─────────────────────────────────────────
function HoverBar({
  paper: p,
  onToggle,
  onOpenPaper,
  raised = false,
}: {
  paper: PaperRecord;
  onToggle?: (paper: PaperRecord, newStatus: "read" | "toread") => void;
  onOpenPaper?: (paper: PaperRecord) => void;
  /** Lift above the floating omnibar on desktop. */
  raised?: boolean;
}) {
  const isRead     = p.status === "read";
  const nextStatus = (isRead ? "toread" : "read") as "read" | "toread";

  return (
    <div
      className={clsx(
        "absolute left-1/2 z-20 -translate-x-1/2 flex items-center gap-2.5 glass rounded-2xl px-3.5 py-2 shadow-panel max-w-[calc(100%-2rem)]",
        raised ? "bottom-24" : "bottom-4"
      )}
    >
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
      {onToggle && (
        <button
          onClick={() => onToggle(p, nextStatus)}
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
      )}
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
    <div className="absolute top-5 right-5 z-10 flex flex-col items-end gap-1.5 pointer-events-none">
      <span className="pr-1 text-[9px] font-semibold uppercase tracking-widest text-muted/80">
        Clusters
      </span>
      {l1Names.map((name, i) => {
        const color = PALETTE_COLORS[i % PALETTE_COLORS.length];
        const count = papers.filter(p => p.cluster_path?.startsWith(name)).length;
        return (
          <div key={name} className="flex items-center gap-2 rounded-full glass py-1.5 pl-3 pr-2.5">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: color, boxShadow: `0 0 6px ${color}88` }}
            />
            <span className="text-[11px] text-zinc-300 max-w-[160px] truncate leading-none">{name}</span>
            <span className="text-[10px] text-muted tabular-nums">{count}</span>
          </div>
        );
      })}
    </div>
  );
}
