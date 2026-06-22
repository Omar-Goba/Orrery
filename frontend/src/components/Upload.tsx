import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload as UploadIcon, CheckCircle, AlertCircle, FileText, ChevronRight } from "lucide-react";
import clsx from "clsx";
import type { PaperRecord, SSEEvent } from "../api/client";
import { getPaperUrl, uploadPaper } from "../api/client";

type Status = "read" | "toread";

interface UploadState {
  phase: "idle" | "uploading" | "done" | "error";
  step?: string;
  pct?: number;
  paper?: PaperRecord;
  error?: string;
}

export function Upload({ onDone }: { onDone?: () => void }) {
  const [status, setStatus] = useState<Status>("toread");
  const [state, setState] = useState<UploadState>({ phase: "idle" });

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setState({ phase: "uploading", step: "Starting…", pct: 0 });

      try {
        await uploadPaper(file, status, (event: SSEEvent) => {
          if (event.type === "progress") {
            setState({ phase: "uploading", step: event.step ?? "", pct: event.pct ?? 0 });
          } else if (event.type === "done" && "paper" in event) {
            setState({ phase: "done", paper: event.paper });
            onDone?.();
          }
        });
      } catch (err) {
        setState({ phase: "error", error: String(err) });
      }
    },
    [status, onDone]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    disabled: state.phase === "uploading",
  });

  const reset = () => setState({ phase: "idle" });

  return (
    <div className="flex flex-col h-full p-6 gap-6 max-w-2xl mx-auto w-full">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">Add a Paper</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Drop a PDF to OCR, embed, and auto-categorize it in your library.
        </p>
      </div>

      {/* Status toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-500">Status:</span>
        <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
          {(["toread", "read"] as Status[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={clsx(
                "px-4 py-1.5 text-sm font-medium transition-colors",
                status === s
                  ? s === "read"
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-amber-500/20 text-amber-400"
                  : "bg-transparent text-zinc-500 hover:text-zinc-300"
              )}
            >
              {s === "read" ? "Already Read" : "Want to Read"}
            </button>
          ))}
        </div>
      </div>

      {/* Drop zone */}
      {state.phase === "idle" && (
        <div
          {...getRootProps()}
          className={clsx(
            "flex-1 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-4 cursor-pointer transition-all",
            isDragActive
              ? "border-indigo-500 bg-indigo-500/5"
              : "border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800/30"
          )}
        >
          <input {...getInputProps()} />
          <div className="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center">
            <UploadIcon size={28} className={isDragActive ? "text-indigo-400" : "text-zinc-500"} />
          </div>
          <div className="text-center">
            <p className="text-zinc-300 font-medium">
              {isDragActive ? "Drop it!" : "Drag & drop a PDF"}
            </p>
            <p className="text-zinc-600 text-sm mt-1">or click to browse</p>
          </div>
        </div>
      )}

      {/* Progress */}
      {state.phase === "uploading" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="w-full max-w-md space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-300 font-medium">{state.step}</span>
              <span className="text-zinc-500">{state.pct}%</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-indigo-400 transition-all duration-500"
                style={{ width: `${state.pct}%` }}
              />
            </div>
            <div className="grid grid-cols-5 gap-1 mt-4">
              {["OCR", "Chunk", "Embed", "Cluster", "Done"].map((label, i) => {
                const pct = state.pct ?? 0;
                const thresholds = [20, 30, 60, 85, 100];
                const active = pct >= thresholds[i];
                const current = i === 0 ? pct < 20 : pct >= thresholds[i - 1] && pct < thresholds[i];
                return (
                  <div key={label} className="flex flex-col items-center gap-1">
                    <div
                      className={clsx(
                        "w-2 h-2 rounded-full transition-colors",
                        active ? "bg-indigo-500" : current ? "bg-indigo-500 animate-pulse" : "bg-zinc-700"
                      )}
                    />
                    <span className={clsx("text-[10px]", active ? "text-zinc-400" : "text-zinc-700")}>
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Done */}
      {state.phase === "done" && state.paper && (
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <CheckCircle size={48} className="text-emerald-400" />
          <div className="text-center space-y-1">
            <p className="text-zinc-100 font-semibold">Paper added to library!</p>
            <p className="text-zinc-500 text-sm">{state.paper.title || state.paper.filename}</p>
          </div>
          {state.paper.cluster_path && (
            <div className="flex items-center gap-2 px-4 py-2 bg-zinc-800 rounded-xl border border-zinc-700 text-sm">
              <FileText size={14} className="text-zinc-500" />
              {state.paper.cluster_path.split("/").map((part, i, arr) => (
                <span key={i} className="flex items-center gap-2">
                  <span className="text-zinc-300">{part.replace(/_/g, " ")}</span>
                  {i < arr.length - 1 && <ChevronRight size={12} className="text-zinc-600" />}
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={reset}
              className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
            >
              Add another
            </button>
            {state.paper.id && (
              <a
                href={getPaperUrl(state.paper.id)}
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm transition-colors"
              >
                Open PDF
              </a>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {state.phase === "error" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <AlertCircle size={40} className="text-red-400" />
          <p className="text-zinc-400 text-sm text-center max-w-sm">{state.error}</p>
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
