const BASE = "http://localhost:8000";

export interface PaperRecord {
  id: string;
  filename: string;
  original_path: string;
  status: "read" | "toread";
  title: string | null;
  author: string | null;
  year: string | null;
  cluster_path: string | null;
  symlink_name: string | null;
  ingested_at: string | null;
  ocr_cached: boolean;
}

export interface Citation {
  paper_id: string;
  author: string;
  year: string;
  title: string;
  cluster_path: string | null;
}

export interface TreeNode {
  name: string;
  type: "folder" | "paper";
  paper_id?: string | null;
  status?: "read" | "toread" | null;
  title?: string | null;
  author?: string | null;
  year?: string | null;
  filename?: string | null;
  children?: TreeNode[];
}

export interface SSEChunk {
  type: "chunk";
  text: string;
}
export interface SSECitations {
  type: "citations";
  papers: Citation[];
}
export interface SSEResult {
  type: "result";
  papers: PaperRecord[];
}
export interface SSEDone {
  type: "done";
}
export interface SSEError {
  type: "error";
  message: string;
}
export interface SSEProgress {
  type: "progress";
  step: string;
  pct: number;
}
export interface SSEUploadDone {
  type: "done";
  paper: PaperRecord;
}

export interface SSEStatusUpdate {
  type: "status_update";
  paper: PaperRecord;
}

export type SSEEvent =
  | SSEChunk
  | SSECitations
  | SSEResult
  | SSEDone
  | SSEError
  | SSEProgress
  | SSEUploadDone
  | SSEStatusUpdate;

export const listPapers = (): Promise<PaperRecord[]> =>
  fetch(`${BASE}/api/papers`).then((r) => r.json());

export const getTree = (): Promise<TreeNode> =>
  fetch(`${BASE}/api/tree`).then((r) => r.json());

// ── Similarity graph (real embedding-space nearest neighbors) ───────────────
export interface SimilarityNeighbor {
  id: string;
  /** Cosine similarity in [0, 1] — higher means more similar. */
  score: number;
}

/** Map of paper_id -> its top-k nearest neighbors by embedding similarity. */
export type SimilarityGraph = Record<string, SimilarityNeighbor[]>;

export const getSimilarityGraph = (): Promise<SimilarityGraph> =>
  fetch(`${BASE}/api/similarity`).then((r) => r.json());

// ── "What should I read next" recommendations ───────────────────────────────
export interface Recommendation {
  paper_id: string;
  title: string;
  author: string | null;
  year: string | null;
  cluster_path: string | null;
  /** One-sentence, human-readable reason this paper was picked. */
  reason: string;
}

export const getRecommendations = (): Promise<Recommendation[]> =>
  fetch(`${BASE}/api/recommendations`).then((r) => r.json());

export const getPaperUrl = (paperId: string) =>
  `${BASE}/api/papers/${paperId}/file`;

export function streamChat(
  message: string,
  onEvent: (e: SSEEvent) => void,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): () => void {
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: history ?? [] }),
      signal: ctrl.signal,
    });
    if (!res.body) return;
    await readSSEStream(res.body, onEvent);
  })().catch(() => {});
  return () => ctrl.abort();
}

export const setPaperStatus = (
  paperId: string,
  status: "read" | "toread",
): Promise<PaperRecord> =>
  fetch(`${BASE}/api/papers/${paperId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }).then((r) => r.json());

export function streamReindex(onEvent: (e: SSEEvent) => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/api/reindex`, {
      method: "POST",
      signal: ctrl.signal,
    });
    if (!res.body) return;
    await readSSEStream(res.body, onEvent);
  })().catch(() => {});
  return () => ctrl.abort();
}

export async function uploadPaper(
  file: File,
  status: "read" | "toread",
  onEvent: (e: SSEEvent) => void
): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  form.append("status", status);
  const { job_id } = await fetch(`${BASE}/api/papers/upload`, {
    method: "POST",
    body: form,
  }).then((r) => r.json());

  return new Promise((resolve, reject) => {
    const es = new EventSource(
      `${BASE}/api/papers/upload/${job_id}/progress`
    );
    es.onmessage = (e) => {
      const event: SSEEvent = JSON.parse(e.data);
      onEvent(event);
      if (event.type === "done" || event.type === "error") {
        es.close();
        if (event.type === "error") reject(new Error(event.message));
        else resolve();
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("SSE connection error"));
    };
  });
}

async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: SSEEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop()!;
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data: ")) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        continue;
      }
    }
  }
}
