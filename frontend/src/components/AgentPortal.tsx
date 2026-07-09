import { useEffect, useRef, useState } from "react";
import {
  Bot, Search, Send, Paperclip, X, FileText, FileUp, Sparkles,
  ChevronDown, MessageSquare,
} from "lucide-react";
import clsx from "clsx";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, PaperRecord, SSEEvent } from "../api/client";
import { getPaperUrl, streamChat, uploadPaper } from "../api/client";

// ── Message types ───────────────────────────────────────────────────────────
type AgentRole = "oracle" | "librarian";

interface Msg {
  id: string;
  role: "user" | AgentRole | "system";
  content: string;
  streaming?: boolean;
  papers?: PaperRecord[];
  citations?: Citation[];
  progress?: { step: string; pct: number };
}

let _seq = 0;
const uid = () => String(++_seq);

// ── Component ───────────────────────────────────────────────────────────────
export function AgentPortal({
  onUploadDone,
  onOpenPaper,
  onOpenPaperId,
  onCitations,
  onUploadStart,
  onUploadArrive,
  onUploadCancel,
  hideHeader = false,
  variant = "panel",
  prefill,
  disableUpload = false,
}: {
  onUploadDone?: () => void;
  onOpenPaper?: (paper: PaperRecord) => void;
  onOpenPaperId?: (paperId: string) => void;
  /** Fired with cited paper ids as soon as the Oracle's citations arrive. */
  onCitations?: (paperIds: string[]) => void;
  /** Fired the moment an upload begins (cluster not known yet). */
  onUploadStart?: () => void;
  /** Fired once the paper's final cluster_path is known. */
  onUploadArrive?: (clusterPath: string) => void;
  /** Fired if an upload fails before a cluster was resolved. */
  onUploadCancel?: () => void;
  hideHeader?: boolean;
  /** "panel" = classic full-height column; "float" = omnibar + expandable glass sheet. */
  variant?: "panel" | "float";
  /** Text to drop into the omnibar + focus signal — bump `token` to re-trigger for the same text. */
  prefill?: { text: string; token: number };
  /** Observer mode: chat still works, but uploads mutate a single-user backend. */
  disableUpload?: boolean;
}) {
  const isFloat = variant === "float";
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: "0",
      role: "system",
      content: "Library initialized — ask anything, or upload a paper to index it.",
    },
  ]);
  const [input, setInput]         = useState("");
  const [busy, setBusy]           = useState(false);
  const [pendingFile, setPending]  = useState<File | null>(null);
  const [uploadStatus, setUpStat] = useState<"read" | "toread">("toread");
  const [open, setOpen]           = useState(false);
  const [dragging, setDragging]   = useState(false);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const abortRef   = useRef<(() => void) | null>(null);

  // ── Float-only: ⌘K / "/" focuses the omnibar ──────────────────────────────
  useEffect(() => {
    if (!isFloat) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable;
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFloat]);

  // ── Float-only: drop a PDF anywhere on the window to ingest it ────────────
  useEffect(() => {
    if (!isFloat || disableUpload) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const onOver  = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onLeave = () => { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    const onDrop  = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f && /\.pdf$/i.test(f.name)) {
        setPending(f);
        setOpen(true);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [isFloat, disableUpload]);

  // Keep the transcript pinned to the latest message when the sheet opens
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView();
  }, [open]);

  // "Ask Oracle" from a StarCard drops a prefilled question into the omnibar
  // and focuses it — bump `prefill.token` to re-trigger for the same text.
  useEffect(() => {
    if (!prefill) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing to an external token, not derivable during render
    setInput(prefill.text);
    if (isFloat) setOpen(true);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.token, isFloat]);

  const scrollDown = () =>
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 40);

  const append = (m: Msg) => {
    setMsgs(prev => [...prev, m]);
    scrollDown();
  };

  const patchById = (id: string, updater: (m: Msg) => Msg) =>
    setMsgs(prev => prev.map(m => (m.id === id ? updater(m) : m)));

  // ── Chat ──────────────────────────────────────────────────────────────────
  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setOpen(true);

    append({ id: uid(), role: "user", content: text });

    const aId = uid();
    append({ id: aId, role: "oracle", content: "", streaming: true });

    let agentDetected = false;

    // Build conversation history for context (last 6 non-system messages)
    const history = msgs
      .filter(m => m.role !== "system" && m.content)
      .slice(-6)
      .map(m => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: m.content,
      }));

    abortRef.current = streamChat(text, (ev: SSEEvent) => {
      // Detect agent from first event
      if (!agentDetected) {
        agentDetected = true;
        if (ev.type === "result") {
          patchById(aId, m => ({ ...m, role: "librarian" }));
        }
      }

      if (ev.type === "chunk") {
        if (!ev.text) return;
        patchById(aId, m => ({ ...m, content: m.content + ev.text }));

      } else if (ev.type === "result") {
        patchById(aId, m => ({ ...m, papers: ev.papers, content: "" }));

      } else if (ev.type === "citations") {
        patchById(aId, m => ({ ...m, citations: ev.papers, streaming: false }));
        if (ev.papers.length) onCitations?.(ev.papers.map(c => c.paper_id));
        setBusy(false);

      } else if (ev.type === "done") {
        patchById(aId, m => ({ ...m, streaming: false }));
        setBusy(false);

      } else if (ev.type === "status_update") {
        onUploadDone?.();  // refresh papers + tree in parent

      } else if (ev.type === "error") {
        patchById(aId, m => ({
          ...m,
          content: `Error: ${(ev as { message: string }).message}`,
          streaming: false,
        }));
        setBusy(false);
      }
      scrollDown();
    }, history);
  };

  // ── Upload ────────────────────────────────────────────────────────────────
  const doUpload = async () => {
    if (!pendingFile) return;
    const file   = pendingFile;
    const status = uploadStatus;
    setPending(null);
    setBusy(true);
    setOpen(true);
    onUploadStart?.();

    const pId = uid();
    append({
      id: pId,
      role: "librarian",
      content: "",
      streaming: true,
      progress: { step: "Starting…", pct: 0 },
    });

    try {
      await uploadPaper(file, status, (ev: SSEEvent) => {
        if (ev.type === "progress") {
          patchById(pId, m => ({
            ...m,
            progress: { step: ev.step, pct: ev.pct },
          }));
        } else if (ev.type === "done" && "paper" in ev) {
          const p = (ev as { type: "done"; paper: PaperRecord }).paper;
          patchById(pId, m => ({
            ...m,
            streaming: false,
            progress: undefined,
            papers: [p],
            content: `Indexed **${p.title ?? p.filename}** into _${
              (p.cluster_path ?? "library").replace("/", " › ")
            }_.`,
          }));
          onUploadArrive?.(p.cluster_path ?? "");
          onUploadDone?.();
        }
        scrollDown();
      });
    } catch {
      onUploadCancel?.();
      patchById(pId, m => ({
        ...m,
        streaming: false,
        progress: undefined,
        content: "Upload failed — check the backend logs.",
      }));
    }
    setBusy(false);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const messageCount = msgs.filter(m => m.role !== "system").length;

  const messages = (
    <>
      {msgs.map(m => (
        <MsgBubble
          key={m.id}
          msg={m}
          onOpenPaper={onOpenPaper}
          onOpenPaperId={onOpenPaperId}
        />
      ))}
      <div ref={bottomRef} />
    </>
  );

  const pendingBar = pendingFile && (
    <div
      className={clsx(
        "flex items-center gap-2.5 px-3 py-2.5 border border-rim rounded-xl",
        isFloat ? "glass w-full animate-fade-up" : "shrink-0 mx-3 mb-2 bg-card"
      )}
    >
      <FileText size={13} className="shrink-0 text-cyan-400" />
      <span className="flex-1 text-xs text-zinc-300 truncate">{pendingFile.name}</span>
      <div className="shrink-0 flex rounded-md overflow-hidden border border-rim text-[11px] font-medium">
        <button
          onClick={() => setUpStat("toread")}
          className={clsx(
            "px-2 py-0.5 transition-colors",
            uploadStatus === "toread"
              ? "bg-amber-500/20 text-amber-400"
              : "text-muted hover:text-ink"
          )}
        >
          to-read
        </button>
        <button
          onClick={() => setUpStat("read")}
          className={clsx(
            "px-2 py-0.5 border-l border-rim transition-colors",
            uploadStatus === "read"
              ? "bg-emerald-500/20 text-emerald-400"
              : "text-muted hover:text-ink"
          )}
        >
          read
        </button>
      </div>
      <button
        onClick={doUpload}
        className="shrink-0 px-3 py-0.5 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-400 text-[11px] font-semibold rounded-md transition-colors"
      >
        Ingest
      </button>
      <button
        onClick={() => setPending(null)}
        aria-label="Remove pending upload"
        className="shrink-0 text-muted hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  );

  const inputBar = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) setPending(f);
          e.target.value = "";
        }}
      />
      <div
        className={clsx(
          "flex items-center gap-2 border rounded-2xl transition-all",
          isFloat
            ? "glass px-3.5 py-3 shadow-panel focus-within:border-cyan-400/40 focus-within:shadow-glow"
            : "bg-card px-3 py-2.5 border-rim hover:border-wire focus-within:border-cyan-500/40"
        )}
      >
        {isFloat && (
          <button
            onClick={() => setOpen(o => !o)}
            aria-label={open ? "Collapse conversation" : "Expand conversation"}
            title={open ? "Collapse conversation" : "Expand conversation"}
            className="relative shrink-0 rounded-lg p-1.5 text-muted hover:text-cyan-400 transition-colors"
          >
            <MessageSquare size={15} />
            {!open && messageCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-cyan-400 px-1 text-[8px] font-bold text-bg tabular-nums">
                {messageCount}
              </span>
            )}
          </button>
        )}
        {!disableUpload && (
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-label="Upload a PDF"
            title="Upload a PDF"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-muted hover:text-cyan-400 transition-colors disabled:opacity-40"
          >
            <Paperclip size={15} />
            {!isFloat && <span className="hidden xl:inline text-[11px] font-semibold">Upload PDF</span>}
          </button>
        )}
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-sm text-ink placeholder-muted outline-none"
          placeholder={isFloat ? "Ask, find, or drop a PDF anywhere…" : "Ask a question or search your library…"}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            if (e.key === "Escape" && isFloat) setOpen(false);
          }}
          disabled={busy}
        />
        {isFloat && !input && (
          <kbd className="hidden md:inline shrink-0 rounded border border-rim px-1.5 py-0.5 font-mono text-[10px] text-muted">
            ⌘K
          </kbd>
        )}
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          aria-label="Send message"
          className={clsx(
            "shrink-0 p-1.5 rounded-xl transition-all",
            input.trim() && !busy
              ? "bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 shadow-glow"
              : "text-wire cursor-not-allowed"
          )}
        >
          {busy ? (
            <div className="w-4 h-4 border-2 border-wire border-t-cyan-400 rounded-full animate-spin-slow" />
          ) : (
            <Send size={14} />
          )}
        </button>
      </div>
    </>
  );

  // ── Float variant: omnibar + expandable glass sheet ───────────────────────
  if (isFloat) {
    return (
      <>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-cyan-400/40 bg-cyan-500/5 px-14 py-10">
              <FileUp size={28} className="text-cyan-400" />
              <p className="text-sm font-medium text-ink">Drop PDF to add it to the library</p>
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2.5 px-4 pb-5">
          {open && (
            <section className="pointer-events-auto flex max-h-[56dvh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl glass shadow-panel animate-fade-up">
              <header className="flex shrink-0 items-center gap-2.5 border-b border-rim/60 px-4 py-3">
                <Sparkles size={14} className="text-cyan-400" />
                <span className="text-[13px] font-semibold tracking-tight text-ink">Agent Portal</span>
                <span className="ml-auto font-mono text-[10px] text-muted">oracle · librarian</span>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Collapse conversation"
                  className="rounded-lg p-1 text-muted transition-colors hover:bg-rim hover:text-ink"
                >
                  <ChevronDown size={14} />
                </button>
              </header>
              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {messages}
              </div>
            </section>
          )}

          {pendingBar && (
            <div className="pointer-events-auto w-full max-w-[680px]">{pendingBar}</div>
          )}

          <div className="pointer-events-auto w-full max-w-[680px]">{inputBar}</div>
        </div>
      </>
    );
  }

  // ── Panel variant: classic full-height column ─────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header — hidden on mobile (App already provides one) */}
      {!hideHeader && (
        <div className="shrink-0 flex items-center gap-2.5 px-4 py-3.5 border-b border-rim">
          <Sparkles size={14} className="text-cyan-400" />
          <span className="text-[13px] font-semibold text-ink tracking-tight">Agent Portal</span>
          <span className="ml-auto text-[10px] text-muted font-mono">oracle · librarian</span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages}
      </div>

      {pendingBar}

      {/* Input bar */}
      <div className="shrink-0 px-3 pb-3">
        {inputBar}
      </div>
    </div>
  );
}

// ── Message bubble ───────────────────────────────────────────────────────────
function MsgBubble({
  msg,
  onOpenPaper,
  onOpenPaperId,
}: {
  msg: Msg;
  onOpenPaper?: (paper: PaperRecord) => void;
  onOpenPaperId?: (paperId: string) => void;
}) {
  if (msg.role === "system") {
    return (
      <div className="py-1 text-center">
        <span className="text-[11px] text-muted font-mono">{msg.content}</span>
      </div>
    );
  }

  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] bg-indigo-600/20 border border-indigo-500/20 text-sm text-ink leading-relaxed rounded-2xl rounded-tr-sm px-3.5 py-2.5">
          {msg.content}
        </div>
      </div>
    );
  }

  const isOracle = msg.role === "oracle";
  const accent   = isOracle ? "text-violet-400"    : "text-cyan-400";
  const bg       = isOracle ? "bg-violet-500/5"    : "bg-cyan-500/5";
  const border   = isOracle ? "border-violet-500/15" : "border-cyan-500/15";
  const label    = isOracle ? "Oracle"             : "Librarian";
  const Icon     = isOracle ? Bot                  : Search;

  return (
    <div className="flex gap-2.5 items-start">
      {/* Avatar */}
      <div
        className={clsx(
          "shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5",
          isOracle ? "bg-violet-500/12" : "bg-cyan-500/12"
        )}
      >
        <Icon size={12} className={accent} />
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        {/* Agent label */}
        <div className={clsx("text-[10px] font-semibold tracking-widest uppercase", accent)}>
          {label}
        </div>

        {/* Progress bar */}
        {msg.progress && (
          <div className={clsx("rounded-xl px-3 py-2.5 border space-y-2", bg, border)}>
            <div className="flex justify-between text-[11px]">
              <span className="text-zinc-400">{msg.progress.step}</span>
              <span className="text-muted tabular-nums">{msg.progress.pct}%</span>
            </div>
            <div className="h-0.5 bg-rim rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-600 to-cyan-400 transition-all duration-500"
                style={{ width: `${msg.progress.pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Streaming / text */}
        {msg.streaming && !msg.content && !msg.progress && (
          <div className={clsx("rounded-xl px-3 py-2.5 border", bg, border)}>
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

        {msg.content && (
          <div
            className={clsx(
              "text-sm text-zinc-200 leading-relaxed rounded-xl px-3.5 py-2.5 border",
              bg, border
            )}
          >
            <MarkdownMessage content={msg.content} />
            {msg.streaming && <span className="typing-cursor" />}
          </div>
        )}

        {/* Paper cards (Librarian find results) */}
        {msg.papers && msg.papers.length > 0 && (
          <div className="space-y-1.5">
            {msg.papers.map(p => (
              <PaperCard key={p.id} paper={p} onOpenPaper={onOpenPaper} />
            ))}
          </div>
        )}

        {/* Citation chips (Oracle) */}
        {msg.citations && msg.citations.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {msg.citations.map(c => (
              <CitationChip key={c.paper_id} c={c} onOpenPaperId={onOpenPaperId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Paper card ───────────────────────────────────────────────────────────────
function PaperCard({
  paper: p,
  onOpenPaper,
}: {
  paper: PaperRecord;
  onOpenPaper?: (paper: PaperRecord) => void;
}) {
  const parts = p.cluster_path?.split("/") ?? [];
  const content = (
    <>
      <div className="shrink-0 w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center">
        <FileText size={13} className="text-cyan-400" />
      </div>
      <div className="flex-1 min-w-0 space-y-0.5 text-left">
        <p className="text-[12px] font-medium text-zinc-200 leading-snug line-clamp-2">
          {p.title ?? p.filename.replace(/\.pdf$/i, "")}
        </p>
        {(p.author || p.year) && (
          <p className="text-[11px] text-muted">
            {[p.author, p.year].filter(Boolean).join(" · ")}
          </p>
        )}
        {parts.length > 0 && (
          <p className="text-[10px] text-wire">
            {parts.join(" › ")}
          </p>
        )}
      </div>
      <span
        className={clsx(
          "shrink-0 self-start text-[9px] px-1.5 py-0.5 rounded font-semibold mt-0.5",
          p.status === "read"
            ? "bg-emerald-500/12 text-emerald-400"
            : "bg-amber-500/12 text-amber-400"
        )}
      >
        {p.status === "read" ? "read" : "to-read"}
      </span>
    </>
  );

  const className = "flex w-full items-start gap-2.5 bg-card border border-rim rounded-xl p-3 hover:border-cyan-500/30 transition-colors group";

  if (onOpenPaper) {
    return (
      <button type="button" onClick={() => onOpenPaper(p)} className={className}>
        {content}
      </button>
    );
  }

  return (
    <a
      href={getPaperUrl(p.id)}
      target="_blank"
      rel="noreferrer"
      className={className}
    >
      {content}
    </a>
  );
}

// ── Citation chip ────────────────────────────────────────────────────────────
function CitationChip({ c, onOpenPaperId }: { c: Citation; onOpenPaperId?: (paperId: string) => void }) {
  const className = "inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-violet-500/10 border border-violet-500/15 text-violet-300 hover:border-violet-400/35 hover:bg-violet-500/15 transition-colors";
  const content = (
    <>
      <span className="font-medium">{c.author}</span>
      <span className="text-violet-500">{c.year}</span>
    </>
  );

  if (onOpenPaperId) {
    return (
      <button type="button" onClick={() => onOpenPaperId(c.paper_id)} className={className}>
        {content}
      </button>
    );
  }

  return (
    <a href={getPaperUrl(c.paper_id)} target="_blank" rel="noreferrer" className={className}>
      {content}
    </a>
  );
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="text-zinc-300">{children}</em>,
  ul: ({ children }) => <ul className="my-2 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-violet-400/40 pl-3 text-zinc-300">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-cyan-300 underline decoration-cyan-400/40 underline-offset-2 hover:text-cyan-200"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-rim/70 px-1 py-0.5 font-mono text-[12px] text-cyan-200">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-rim bg-bg/70 p-2 text-[12px] leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-rim bg-rim/40 px-2 py-1 text-left font-semibold text-ink">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-rim px-2 py-1 text-zinc-300">{children}</td>
  ),
  img: () => null,
};

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}
