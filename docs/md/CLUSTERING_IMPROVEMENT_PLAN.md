# Clustering Quality Improvement Plan

Improvements to how the library reindexes and clusters papers into folders, targeting
three pain points: **grouping quality**, **folder names**, and **tree shape**.

Design constraints (agreed):

- Library stays under ~200 papers → per-paper LLM calls and O(n²) clustering are affordable.
- Taxonomy is fully automatic — no user-defined top levels, no pinning.
- Hybrid ingest (incremental slot-in + drift-triggered reindex) is a separate, later workstream
  and is **out of scope** for this plan.

Current pipeline for reference: OCR → chunk (2000 chars / 150 overlap) → embed chunks with
`mxbai-embed-large` via Ollama → paper vector = normalized mean of all chunk vectors →
recursive Ward clustering on cosine distances (`backend/clustering/hierarchical.py`) →
per-node naming with `gemma3:4b` (`backend/clustering/namer.py`) → symlink tree rebuild
(`backend/services/filesystem.py`).

---

## Workstream 1 — Better paper representations

**Problem.** `EmbeddingService.paper_vector()` averages *every* chunk of the PDF, so
references, acknowledgments, and license boilerplate dilute the topical signal. Bad vectors
→ bad clusters, no matter how good the clustering algorithm is. Separately,
`extract_metadata()` in `backend/agents/librarian.py` uses fragile regex heuristics that
often produce garbage titles, which then poison folder naming.

### 1a. LLM paper summaries as the clustering signal

- New service `backend/services/summarize.py` (`SummaryService`):
  - Input: the OCR text (front section, ~first 8–10k chars).
  - One LLM call returns structured JSON: `{title, author_last, year, summary}` where
    `summary` is 2–3 sentences stating topic, method, and domain — written for
    clustering, not for humans.
  - Model: OpenAI (key already in settings, agents already use it), with fallback to
    local `settings.ollama_namer_model` when no key is configured. Add
    `summary_model` to `backend/config.py`.
  - On any failure, fall back to the existing regex `extract_metadata()` +
    front-matter embedding (1c) so ingestion never hard-fails.
- The **paper vector becomes the embedding of the summary text** (title + summary),
  not the mean of chunk vectors. Chunk embeddings are unchanged — they still serve
  chat/Q&A retrieval.
- Persistence:
  - Add `summary: str | None = None` to `PaperRecord` (`backend/models.py`) —
    papers.json is schema-flexible JSON, old records load fine with `None`.
  - Also store `summary` in the paper-vector metadata in Chroma so reindex can run
    without touching papers.json.

### 1b. Replace regex metadata extraction

- `title`, `author`, `year` come from the same structured LLM call as the summary
  (one call per paper, not two).
- Keep `extract_metadata()` as the fallback path only. This fixes the mangled titles
  that currently feed the namer.

### 1c. Fallback vector when no LLM is available

- If summarization fails entirely, build the paper vector from **front matter only**:
  chunks 0–3, and drop any chunk after the first line matching
  `^\s*(references|bibliography)\b` (case-insensitive). Strictly better than the
  current whole-document mean, with zero extra cost.

### 1d. Fix Ward-on-cosine

- `HierarchicalClusterer._cluster()` currently feeds cosine distances into Ward
  linkage; Ward's variance math is only valid for Euclidean distance.
- Fix: L2-normalize the vector matrix once, then `pdist(matrix, metric="euclidean")`
  → `linkage(..., method="ward")`. On unit vectors, Euclidean is monotonically
  equivalent to cosine (`d² = 2 − 2·cos`), so semantics are preserved and the math
  becomes sound.
- Note: any absolute distance thresholds change scale (cosine 0.20 ≈ euclidean 0.63);
  irrelevant once Workstream 2 removes the absolute threshold.

### Migration

- New flag `scripts/bulk_ingest.py --revector`:
  - For every paper already in Chroma: load cached OCR text (`*.ocr.json` — no
    re-OCR), run `SummaryService`, embed the summary, `upsert_paper_vector()` with
    refreshed metadata, update the `PaperRecord`.
  - Leaves the chunks collection untouched — **no chunk re-embedding**, so this is
    ~200 small LLM calls + ~200 embeddings, minutes not hours.
  - Ends with a normal recluster + rebuild.
- `--reset` remains the nuclear option; `--revector` is the intended upgrade path.

---

## Workstream 2 — Silhouette-driven splitting (tree shape)

**Problem.** `_choose_k()`'s "largest gap in the last 6 dendrogram heights" heuristic is
noisy, and `COHESION_THRESHOLD = 0.20` is an absolute number tied to the current embedding
model — it silently decides whether the tree is too flat or too deep. Leaves have no upper
size bound, and single-outlier papers get forced into whichever folder rejects them least.

All changes in `backend/clustering/hierarchical.py`.

### 2a. Evaluate splits directly instead of guessing k

- At each node with `n > MIN_LEAF_SIZE`:
  - For each `k` in `2..min(BRANCH_MAX, n // MIN_LEAF_SIZE)`:
    - `labels = fcluster(Z, k, criterion="maxclust")`
    - Skip k if any child < `MIN_LEAF_SIZE` (replaces the current decrement loop).
    - Score with `sklearn.metrics.silhouette_score(matrix, labels, metric="cosine")`.
  - Choose the k with the best silhouette.
- **Split-or-leaf decision:** split only if best silhouette ≥ `MIN_SILHOUETTE`
  (new constant, default `0.08`, tune empirically). This single relative rule replaces
  both `_choose_k()` and `COHESION_THRESHOLD`, and adapts automatically to any
  embedding model. Degenerate lopsided splits score poorly and are rejected for free.
- Cost: silhouette is O(n²) per candidate k; with n ≤ 200 and ≤ 6 candidates per node
  this is milliseconds.
- Dependency: add `scikit-learn` to `backend/pyproject.toml` (scipy/numpy already present).

### 2b. Cap leaf size

- New constant `MAX_LEAF_SIZE = 14`.
- If a node would become a leaf (cohesion/silhouette says don't split) but
  `n > MAX_LEAF_SIZE`, force the best available split anyway (highest-silhouette k
  that satisfies `MIN_LEAF_SIZE`). A 40-paper folder is unusable even if cohesive.

### 2c. Outlier extraction → `Misc`

- After the tree is built, post-process leaves:
  - For each leaf, compute the centroid and each member's cosine similarity to it.
  - Pull out papers with `sim < leaf_mean_sim − 2·leaf_std` **and** `sim < 0.55`
    (both conditions, to avoid gutting tight leaves; thresholds tunable constants).
  - Collect extracted papers into a synthetic top-level `ClusterNode(name="Misc")`.
    Skip naming for it (fixed name).
- Rationale: a few honest "Misc" entries beat one polluted topic folder, and the
  namer stops being confused by off-topic members.
- Guard: never extract from a leaf below `MIN_LEAF_SIZE + 1` members.

### Kept as-is

`MIN_LEAF_SIZE = 3`, `MAX_DEPTH = 6`, `BRANCH_MIN/MAX = 2/7`, the recursive
structure, and the `ClusterNode` / `ClusterTree` public API — Workstream 3 and the
filesystem layer see no interface change beyond the extra `Misc` node.

---

## Workstream 3 — Single-call tree naming

**Problem.** `ClusterNamer.name_cluster()` names each node in isolation, so sibling
folders collide ("Deep Learning Methods" × 3), parents repeat child terms, and names are
generic. It also sees raw (often mangled) titles.

All changes in `backend/clustering/namer.py` plus the two call sites
(`LibrarianAgent` in `backend/agents/librarian.py`, `scripts/bulk_ingest.py`).

### 3a. Name the whole tree in one LLM call

- New method `ClusterNamer.name_tree(tree: ClusterTree, records) -> None`:
  1. Walk the tree, assign each node a stable id (`n0`, `n0.1`, `n0.1.2`, …).
  2. Serialize to a compact prompt: for each **leaf**, its id + up to 10 member
     descriptions (paper `summary` from Workstream 1, falling back to `title`,
     falling back to `filename`, each truncated ~150 chars); for each **internal**
     node, its id + child ids. With ≤ 200 papers this fits one prompt easily.
  3. Ask for JSON `{node_id: name}` covering every node, with explicit rules:
     - 2–4 words, Title Case, no punctuation/numbers.
     - **Sibling names must be mutually distinct.**
     - Child names must not repeat their parent's words.
     - Prefer specific over generic (ban bare "Deep Learning Methods",
       "Machine Learning", "Research Papers"-style names).
  4. Parse strictly (JSON only), run each name through the existing `_sanitize()`.
- **Validation pass** after parsing:
  - Missing node id, empty name, or duplicate among siblings → re-prompt **once**
    listing only the offending nodes and the names already taken.
  - Still failing → fall back to the existing per-node `name_cluster()` for just
    those nodes, then suffix dedupe (`"Foo"`, `"Foo 2"`) as the last resort so the
    filesystem never gets colliding sibling directories (which currently silently
    merge in `rebuild_tree`).
- Model: one call per reindex → use the best available model. New setting
  `namer_model` preferring OpenAI when the key is set, else `gemma3:4b`. Keep the
  per-node Ollama path as the offline fallback.

### 3b. Feed the namer summaries, not titles

- Both `name_tree` and the fallback `name_cluster` receive the Workstream 1
  summaries when available. Depends on 1a but degrades gracefully to titles.

### 3c. Update call sites

- `LibrarianAgent.reindex()` / `ingest()`: replace the per-top-node
  `_name_node()` loop with one `namer.name_tree(tree, paper_store)` await.
  `_name_node()` stays (used by the fallback path).
- `scripts/bulk_ingest.py`: same replacement in the naming phase.

---

## Rollout order & verification

Order matters: **1 → 2 → 3**. Better vectors improve everything downstream; the
summaries from 1 are also the naming input for 3.

| Step | Change | Migration needed |
|------|--------|------------------|
| 1 | Summaries + metadata + Ward fix | `bulk_ingest.py --revector` (once) |
| 2 | Silhouette splitting + leaf cap + Misc | none — just `POST /api/reindex` |
| 3 | Single-call tree naming | none — just `POST /api/reindex` |

Verification at each step (no test suite exists yet, so this is empirical):

1. **Quality snapshot script** (`scripts/eval_clusters.py`, throwaway): print the tree
   with per-leaf mean intra-cluster cosine similarity and global silhouette of leaf
   assignments. Run before Step 1 to capture a baseline, and after each step —
   silhouette should rise at Step 1 (better vectors) and again at Step 2.
2. **Eyeball pass** after each step: `POST /api/reindex`, inspect `dbs/output/` and the
   UI tree. Specifically check: no near-duplicate sibling names, no folder > 14 papers,
   no 1-paper folders outside `Misc`, `Misc` contains genuinely odd papers.
3. **Regression checks**: chat/Q&A still works (chunks untouched), `find papers` agent
   still works (`query_papers` now searches summary vectors — semantic search should
   *improve*), status toggle still renames symlinks, upload flow completes end-to-end.

## Risks & mitigations

- **LLM summary variance** → summaries are cached (papers.json + Chroma metadata) and
  only regenerated via `--revector`, so vectors are stable between reindexes.
- **OpenAI unavailable/offline** → every LLM step has a local-Ollama or heuristic
  fallback; the pipeline never hard-fails on a single paper (existing per-paper
  try/except in bulk ingest stays).
- **`MIN_SILHOUETTE` mistuned** → it's one constant; the eval script makes retuning a
  two-minute loop. Start at 0.08, raise if the tree is too deep, lower if too flat.
- **Name churn across reindexes** (names are still LLM-generated) → accepted for now;
  name-reuse matching belongs to the future hybrid-ingest workstream.
