import { useCallback, useRef, useState } from "react";
import {
  Bot, Search, Send, Paperclip, X, FileText, Sparkles,
} from "lucide-react";
import clsx from "clsx";
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
  hideHeader = false,
}: {
  onUploadDone?: () => void;
  hideHeader?: boolean;
}) {
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
  const bottomRef  = useRef<HTMLDivElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const abortRef   = useRef<(() => void) | null>(null);

  const scrollDown = () =>
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 40);

  const append = (m: Msg) => {
    setMsgs(prev => [...prev, m]);
    scrollDown();
  };

  const patchById = (id: string, updater: (m: Msg) => Msg) =>
    setMsgs(prev => prev.map(m => (m.id === id ? updater(m) : m)));

  // ── Chat ──────────────────────────────────────────────────────────────────
  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);

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
  }, [input, busy, msgs, onUploadDone]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const doUpload = useCallback(async () => {
    if (!pendingFile) return;
    const file   = pendingFile;
    const status = uploadStatus;
    setPending(null);
    setBusy(true);

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
            content: `Indexed **${p.title ?? p.filename}** into _${
              (p.cluster_path ?? "library").replace("/", " › ")
            }_.`,
          }));
          onUploadDone?.();
        }
        scrollDown();
      });
    } catch {
      patchById(pId, m => ({
        ...m,
        streaming: false,
        progress: undefined,
        content: "Upload failed — check the backend logs.",
      }));
    }
    setBusy(false);
  }, [pendingFile, uploadStatus, onUploadDone]);

  // ── Render ────────────────────────────────────────────────────────────────
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
        {msgs.map(m => (
          <MsgBubble key={m.id} msg={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Pending file bar */}
      {pendingFile && (
        <div className="shrink-0 mx-3 mb-2 px-3 py-2.5 bg-card border border-rim rounded-xl flex items-center gap-2.5">
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
          <button onClick={() => setPending(null)} className="shrink-0 text-muted hover:text-ink">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Input bar */}
      <div className="shrink-0 px-3 pb-3">
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
            "flex items-center gap-2 bg-card border rounded-2xl px-3 py-2.5 transition-colors",
            busy ? "border-rim" : "border-rim hover:border-wire focus-within:border-cyan-500/40"
          )}
        >
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="Upload a PDF"
            className="shrink-0 p-1 text-muted hover:text-cyan-400 transition-colors disabled:opacity-40"
          >
            <Paperclip size={15} />
          </button>
          <input
            className="flex-1 bg-transparent text-[13px] text-ink placeholder-muted outline-none"
            placeholder="Ask, find, or upload a paper…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            disabled={busy}
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
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
      </div>
    </div>
  );
}

// ── Message bubble ───────────────────────────────────────────────────────────
function MsgBubble({ msg }: { msg: Msg }) {
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
        <div className="max-w-[88%] bg-indigo-600/20 border border-indigo-500/20 text-[13px] text-ink leading-relaxed rounded-2xl rounded-tr-sm px-3.5 py-2.5">
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
              "text-[13px] text-zinc-200 leading-relaxed whitespace-pre-wrap rounded-xl px-3.5 py-2.5 border",
              bg, border
            )}
          >
            <span dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
            {msg.streaming && <span className="typing-cursor" />}
          </div>
        )}

        {/* Paper cards (Librarian find results) */}
        {msg.papers && msg.papers.length > 0 && (
          <div className="space-y-1.5">
            {msg.papers.map(p => (
              <PaperCard key={p.id} paper={p} />
            ))}
          </div>
        )}

        {/* Citation chips (Oracle) */}
        {msg.citations && msg.citations.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {msg.citations.map(c => (
              <CitationChip key={c.paper_id} c={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Paper card ───────────────────────────────────────────────────────────────
function PaperCard({ paper: p }: { paper: PaperRecord }) {
  const parts = p.cluster_path?.split("/") ?? [];
  return (
    <a
      href={getPaperUrl(p.id)}
      target="_blank"
      rel="noreferrer"
      className="flex items-start gap-2.5 bg-card border border-rim rounded-xl p-3 hover:border-cyan-500/30 transition-colors group"
    >
      <div className="shrink-0 w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center">
        <FileText size={13} className="text-cyan-400" />
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
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
    </a>
  );
}

// ── Citation chip ────────────────────────────────────────────────────────────
function CitationChip({ c }: { c: Citation }) {
  return (
    <a
      href={getPaperUrl(c.paper_id)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-violet-500/10 border border-violet-500/15 text-violet-300 hover:border-violet-400/35 hover:bg-violet-500/15 transition-colors"
    >
      <span className="font-medium">{c.author}</span>
      <span className="text-violet-500">{c.year}</span>
    </a>
  );
}

// ── Minimal markdown renderer (bold + italic only) ───────────────────────────
function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}
