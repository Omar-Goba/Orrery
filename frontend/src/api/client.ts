const BASE = "http://localhost:8000";

export type ApiMode = "normal" | "tour";

const apiPrefix = (mode: ApiMode = "normal") =>
  mode === "tour" ? "/api/tour" : "/api";

const withCookies: RequestCredentials = "include";

async function jsonOrThrow<T>(resp: Response): Promise<T> {
  if (!resp.ok) throw new Error(`Request failed with status ${resp.status}`);
  return resp.json();
}

export interface PaperRecord {
  id: string;
  filename: string;
  source_filename: string;
  status: "read" | "toread";
  title: string | null;
  author: string | null;
  year: string | null;
  summary: string | null;
  cluster_path: string | null;
  ingested_at: string | null;
  ocr_cached: boolean;
}

export interface TourGalaxy {
  display_name: string;
  stars: number;
  ignited: number;
  constellations: number;
}

export interface AuthUser {
  handle: string;
  display_name: string;
  role: "keeper" | "voyager";
  storage_used_bytes: number;
  storage_quota_bytes: number;
  created_at: string;
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

export const getTourGalaxy = (): Promise<TourGalaxy> =>
  fetch(`${BASE}/api/tour/galaxy`).then(jsonOrThrow<TourGalaxy>);

export const listPapers = (mode: ApiMode = "normal"): Promise<PaperRecord[]> =>
  fetch(`${BASE}${apiPrefix(mode)}/papers`, { credentials: withCookies })
    .then(jsonOrThrow<PaperRecord[]>);

export const getTree = (mode: ApiMode = "normal"): Promise<TreeNode> =>
  fetch(`${BASE}${apiPrefix(mode)}/tree`, { credentials: withCookies })
    .then(jsonOrThrow<TreeNode>);

// ── Similarity graph (real embedding-space nearest neighbors) ───────────────
export interface SimilarityNeighbor {
  id: string;
  /** Cosine similarity in [0, 1] — higher means more similar. */
  score: number;
}

/** Map of paper_id -> its top-k nearest neighbors by embedding similarity. */
export type SimilarityGraph = Record<string, SimilarityNeighbor[]>;

export const getSimilarityGraph = (mode: ApiMode = "normal"): Promise<SimilarityGraph> =>
  fetch(`${BASE}${apiPrefix(mode)}/similarity`, { credentials: withCookies })
    .then(jsonOrThrow<SimilarityGraph>);

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
  fetch(`${BASE}/api/recommendations`, { credentials: withCookies })
    .then(jsonOrThrow<Recommendation[]>);

export async function loginAuth(handle: string, password: string): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: withCookies,
    body: JSON.stringify({ handle, password }),
  });
  return jsonOrThrow<AuthUser>(resp);
}

export async function signupAuth(
  handle: string,
  password: string,
  inviteCode?: string,
): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: withCookies,
    body: JSON.stringify({ handle, password, invite_code: inviteCode || undefined }),
  });
  return jsonOrThrow<AuthUser>(resp);
}

export async function getMe(): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/api/auth/me`, { credentials: withCookies });
  return jsonOrThrow<AuthUser>(resp);
}

export async function logoutAuth(): Promise<void> {
  await fetch(`${BASE}/api/auth/logout`, {
    method: "POST",
    credentials: withCookies,
  });
}

export const getPaperUrl = (paperId: string, mode: ApiMode = "normal") =>
  `${BASE}${apiPrefix(mode)}/papers/${paperId}/file`;

export function streamChat(
  message: string,
  onEvent: (e: SSEEvent) => void,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
  mode: ApiMode = "normal",
): () => void {
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}${apiPrefix(mode)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: withCookies,
      body: JSON.stringify({ message, history: history ?? [] }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      onEvent({ type: "error", message: `Chat failed with status ${res.status}` });
      return;
    }
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
    credentials: withCookies,
    body: JSON.stringify({ status }),
  }).then(jsonOrThrow<PaperRecord>);

export function streamReindex(onEvent: (e: SSEEvent) => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/api/reindex`, {
      method: "POST",
      credentials: withCookies,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      onEvent({ type: "error", message: `Reindex failed with status ${res.status}` });
      return;
    }
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
  const uploadResp = await fetch(`${BASE}/api/papers/upload`, {
    method: "POST",
    credentials: withCookies,
    body: form,
  });

  if (uploadResp.status === 409) {
    // Content-hash dedup: identical bytes already exist in the library.
    const body = await uploadResp.json();
    throw new Error(
      `This PDF is already in the library (${body.paper?.title ?? body.paper?.filename ?? "existing paper"}).`
    );
  }
  if (!uploadResp.ok) {
    throw new Error(`Upload failed with status ${uploadResp.status}`);
  }
  const { job_id } = await uploadResp.json();

  return new Promise((resolve, reject) => {
    const es = new EventSource(
      `${BASE}/api/papers/upload/${job_id}/progress`,
      { withCredentials: true }
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
