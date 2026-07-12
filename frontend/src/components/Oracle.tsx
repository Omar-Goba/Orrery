import { useEffect, useRef, useState } from "react";
import { Send, ExternalLink, Bot, User } from "lucide-react";
import clsx from "clsx";
import type { Citation, SSEEvent } from "../api/client";
import { getPaperUrl, streamChat } from "../api/client";
import { useSSEStream } from "../hooks/useSSEStream";

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  streaming?: boolean;
}

export function Oracle() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stream = useSSEStream();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", streaming: true },
    ]);

    stream.start(() => streamChat(text, (event: SSEEvent) => {
      if (event.type === "chunk") {
        if (!event.text) return;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === "assistant") {
            updated[updated.length - 1] = { ...last, content: last.content + event.text };
          }
          return updated;
        });
      } else if (event.type === "result") {
        // find_paper was called instead of ask_oracle — show papers as content
        const lines = event.papers
          .map((p) => `• ${p.title || p.filename} (${p.year || "n.d."})`)
          .join("\n");
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === "assistant") {
            updated[updated.length - 1] = {
              ...last,
              content: `Here are the closest matches in your library:\n\n${lines}`,
            };
          }
          return updated;
        });
      } else if (event.type === "citations") {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === "assistant") {
            updated[updated.length - 1] = { ...last, citations: event.papers, streaming: false };
          }
          return updated;
        });
        setBusy(false);
      } else if (event.type === "done") {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === "assistant" && last.streaming) {
            updated[updated.length - 1] = { ...last, streaming: false };
          }
          return updated;
        });
        setBusy(false);
      } else if (event.type === "error") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `Error: ${event.message}`,
            streaming: false,
          };
          return updated;
        });
        setBusy(false);
      }
    }));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
            <Bot size={40} />
            <p className="text-sm">Ask anything about your paper collection</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={clsx("flex gap-3", msg.role === "user" ? "justify-end" : "justify-start")}
          >
            {msg.role === "assistant" && (
              <div className="shrink-0 w-7 h-7 rounded-full bg-indigo-500/20 flex items-center justify-center mt-0.5">
                <Bot size={14} className="text-indigo-400" />
              </div>
            )}
            <div className={clsx("max-w-[75%] space-y-2", msg.role === "user" && "items-end")}>
              <div
                className={clsx(
                  "rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-indigo-600 text-white rounded-tr-sm"
                    : "bg-zinc-800/80 text-zinc-200 rounded-tl-sm"
                )}
              >
                {msg.content}
                {msg.streaming && msg.content && <span className="typing-cursor" />}
                {msg.streaming && !msg.content && (
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
                  </span>
                )}
              </div>
              {msg.citations && msg.citations.length > 0 && (
                <div className="flex flex-wrap gap-2 pl-1">
                  {msg.citations.map((c) => (
                    <CitationChip key={c.paper_id} citation={c} />
                  ))}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="shrink-0 w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center mt-0.5">
                <User size={14} className="text-zinc-300" />
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 p-4">
        <div className="flex gap-2 bg-zinc-800/60 rounded-xl border border-zinc-700 focus-within:border-indigo-500 transition-colors">
          <input
            className="flex-1 bg-transparent px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 outline-none"
            placeholder="Ask about your papers…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            disabled={busy}
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className={clsx(
              "m-1.5 px-3 rounded-lg transition-all",
              input.trim() && !busy
                ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                : "bg-zinc-700 text-zinc-500 cursor-not-allowed"
            )}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function CitationChip({ citation }: { citation: Citation }) {
  const url = getPaperUrl(citation.paper_id);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 hover:border-indigo-500/50 hover:bg-zinc-700 transition-all text-xs text-zinc-400 hover:text-zinc-200 group"
    >
      <ExternalLink size={11} className="text-zinc-600 group-hover:text-indigo-400" />
      <span className="font-medium">{citation.author || "Unknown"}</span>
      <span className="text-zinc-600">{citation.year}</span>
      {citation.cluster_path && (
        <span className="text-zinc-700 hidden sm:inline">· {citation.cluster_path.replace("/", " › ")}</span>
      )}
    </a>
  );
}
