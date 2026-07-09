import { useEffect, useState } from "react";
import {
  BookMarked,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import clsx from "clsx";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { PaperRecord } from "../api/client";
import { getPaperUrl } from "../api/client";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfReaderProps {
  paper: PaperRecord;
  mode: "desktop" | "mobile";
  onClose: () => void;
  onToggleStatus?: (paper: PaperRecord, newStatus: "read" | "toread") => void;
}

const MIN_SCALE = 0.7;
const MAX_SCALE = 2.2;
const SCALE_STEP = 0.15;

export function PdfReader({ paper, mode, onClose, onToggleStatus }: PdfReaderProps) {
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [rotation, setRotation] = useState(0);
  const [loadError, setLoadError] = useState(false);

  const title = paper.title ?? paper.filename.replace(/\.pdf$/i, "");
  const fileUrl = getPaperUrl(paper.id);
  const isRead = paper.status === "read";
  const nextStatus = isRead ? "toread" : "read";

  const goPrev = () => setPageNumber((page) => Math.max(1, page - 1));
  const goNext = () => setPageNumber((page) => Math.min(pageCount || page + 1, page + 1));
  const zoomOut = () => setScale((value) => Math.max(MIN_SCALE, Number((value - SCALE_STEP).toFixed(2))));
  const zoomIn = () => setScale((value) => Math.min(MAX_SCALE, Number((value + SCALE_STEP).toFixed(2))));
  const resetZoom = () => setScale(1.1);
  const rotate = () => setRotation((value) => (value + 90) % 360);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setPageNumber((page) => Math.max(1, page - 1));
      } else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        setPageNumber((page) => Math.min(pageCount || page + 1, page + 1));
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setScale((value) => Math.min(MAX_SCALE, Number((value + SCALE_STEP).toFixed(2))));
      } else if (event.key === "-") {
        event.preventDefault();
        setScale((value) => Math.max(MIN_SCALE, Number((value - SCALE_STEP).toFixed(2))));
      } else if (event.key === "0") {
        event.preventDefault();
        setScale(1.1);
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        setRotation((value) => (value + 90) % 360);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pageCount]);

  return (
    <section
      className={clsx(
        "flex h-full min-h-0 flex-col overflow-hidden bg-bg text-ink",
        mode === "mobile" && "fixed inset-0 z-50"
      )}
    >
      <header className="shrink-0 border-b border-rim bg-surface/95 backdrop-blur-sm">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-rim hover:text-ink"
            title="Close reader"
          >
            <X size={15} />
          </button>

          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-zinc-100">{title}</div>
            <div className="truncate text-[10px] text-muted">
              {[paper.author, paper.year].filter(Boolean).join(" · ") || paper.filename}
            </div>
          </div>

          <button
            onClick={() => onToggleStatus?.(paper, nextStatus)}
            className={clsx(
              "hidden shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors sm:inline-flex",
              isRead
                ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                : "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
            )}
            title={isRead ? "Mark as to-read" : "Mark as read"}
          >
            <BookMarked size={12} />
            {isRead ? "read" : "to-read"}
          </button>

          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-rim hover:text-cyan-400"
            title="Open PDF in new tab"
          >
            <ExternalLink size={15} />
          </a>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto border-t border-rim/70 px-3 py-2">
          <button
            onClick={goPrev}
            disabled={pageNumber <= 1}
            className="rounded-lg border border-rim bg-card px-2 py-1 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
            title="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-20 text-center text-[11px] tabular-nums text-muted">
            Page {pageNumber} / {pageCount || "?"}
          </span>
          <button
            onClick={goNext}
            disabled={!!pageCount && pageNumber >= pageCount}
            className="rounded-lg border border-rim bg-card px-2 py-1 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
            title="Next page"
          >
            <ChevronRight size={14} />
          </button>

          <div className="mx-1 h-5 w-px shrink-0 bg-rim" />

          <button
            onClick={zoomOut}
            className="rounded-lg border border-rim bg-card px-2 py-1 text-muted transition-colors hover:text-ink"
            title="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={resetZoom}
            className="min-w-14 rounded-lg border border-rim bg-card px-2 py-1 text-[11px] tabular-nums text-muted transition-colors hover:text-ink"
            title="Reset zoom"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            onClick={zoomIn}
            className="rounded-lg border border-rim bg-card px-2 py-1 text-muted transition-colors hover:text-ink"
            title="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={rotate}
            className="rounded-lg border border-rim bg-card px-2 py-1 text-muted transition-colors hover:text-ink"
            title="Rotate"
          >
            <RotateCw size={14} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto bg-[#05070b]">
        <Document
          key={paper.id}
          file={fileUrl}
          onLoadSuccess={({ numPages }) => {
            setPageCount(numPages);
            setPageNumber(1);
            setLoadError(false);
          }}
          onLoadError={() => setLoadError(true)}
          loading={<ReaderLoading />}
          error={<ReaderError fileUrl={fileUrl} onClose={onClose} />}
          className="min-h-full"
        >
          {!loadError && (
            <div className="mx-auto flex min-h-full w-fit items-start justify-center px-4 py-6 sm:px-8">
              <Page
                pageNumber={pageNumber}
                scale={scale}
                rotate={rotation}
                renderAnnotationLayer={false}
                renderTextLayer={false}
                className="overflow-hidden rounded-lg bg-white shadow-panel"
              />
            </div>
          )}
        </Document>
      </div>
    </section>
  );
}

function ReaderLoading() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center text-muted">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-rim border-t-cyan-400 animate-spin-slow" />
        <p className="text-[12px]">Loading PDF...</p>
      </div>
    </div>
  );
}

function ReaderError({ fileUrl, onClose }: { fileUrl: string; onClose: () => void }) {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center px-6 text-center">
      <div className="max-w-sm rounded-2xl border border-rim bg-surface p-5 shadow-panel">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
          <BookMarked size={18} />
        </div>
        <h2 className="text-sm font-semibold text-ink">Could not load this PDF</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          The embedded reader failed, but the original file can still be opened directly.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-[11px] font-semibold text-cyan-400 transition-colors hover:bg-cyan-500/25"
          >
            Open original
          </a>
          <button
            onClick={onClose}
            className="rounded-lg border border-rim px-3 py-1.5 text-[11px] font-semibold text-muted transition-colors hover:text-ink"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
