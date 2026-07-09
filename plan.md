# Clustering Improvement Implementation Plan

This plan turns `CLUSTERING_IMPROVEMENT_PLAN.md` into an execution roadmap for improving paper grouping quality, folder naming, and taxonomy shape while preserving the current app contracts.

## Goals

- Replace noisy whole-document paper vectors with summary-based vectors.
- Improve metadata quality by using the same structured LLM call for title, author, year, and clustering summary.
- Fix Ward clustering to use Euclidean distances over normalized vectors.
- Replace heuristic split selection with silhouette-driven splitting.
- Cap oversized leaves and extract true outliers into `Misc`.
- Name the full cluster tree in one coordinated LLM call to avoid duplicate or generic sibling folders.
- Preserve existing upload, reindex, chat, search, status toggle, and filesystem behavior.

## Non-Goals

- No hybrid incremental clustering or drift-triggered reindexing.
- No user-defined taxonomy levels, pinned folders, or manual override system.
- No destructive migration path as the default. `--reset` remains available but is not the upgrade path.
- No changes to chunk embeddings for chat and Q&A retrieval.

## Current Pipeline

The existing flow is:

1. OCR PDF text with `OCRService`.
2. Extract metadata with regex heuristics in `backend/agents/librarian.py` and `scripts/bulk_ingest.py`.
3. Chunk text at roughly 2000 chars with 150 overlap.
4. Embed chunks with Ollama `mxbai-embed-large`.
5. Build paper vector by normalized mean of all chunk vectors.
6. Store chunk vectors and paper vector in Chroma.
7. Recursively cluster with Ward linkage over cosine distances.
8. Name each node independently with `ClusterNamer.name_cluster()`.
9. Rebuild `dbs/output/` symlink tree.

The weak points are noisy paper vectors, invalid Ward distance math, heuristic split selection, oversized leaves, forced outliers, and isolated folder naming.

## Phase 1: Summary-Based Paper Representations

### 1.1 Add Persistent Summary Field

Update `backend/models.py`:

- Add `summary: str | None = None` to `PaperRecord`.
- Keep the field optional so existing `dbs/papers.json` records remain loadable.

Update `frontend/src/api/client.ts`:

- Add `summary?: string | null` to the frontend `PaperRecord` type if that type mirrors backend responses.
- Do not add UI rendering unless a future task asks for it.

### 1.2 Add Summary Configuration

Update `backend/config.py` and `.env.example`:

- Add `summary_model` for structured paper summary generation.
- Add or clarify `namer_model` if tree naming should prefer OpenAI when available and fall back to the existing Ollama model.
- Do not read or modify `.env`.

### 1.3 Create Summary Service

Create `backend/services/summarize.py` with `SummaryService`.

Responsibilities:

- Input OCR text and filename.
- Use only the front section of the document, around the first 8-10k chars.
- Return structured data: `title`, `author_last`, `year`, `summary`.
- Generate a 2-3 sentence summary optimized for clustering: topic, method, and domain.
- Use OpenAI when `settings.openai_api_key` is configured.
- Fall back to local Ollama when OpenAI is unavailable.
- Fall back to existing regex metadata and front-matter embedding behavior when all LLM paths fail.

Implementation notes:

- Parse JSON strictly.
- Normalize malformed values defensively.
- Treat an empty or generic summary as a failure and use fallback.
- Keep failures per-paper, never fatal to the entire ingest or revector run.

### 1.4 Replace Regex Metadata as Primary Path

Update ingest paths:

- `backend/agents/librarian.py`
- `scripts/bulk_ingest.py`

New behavior:

- Run `SummaryService` after OCR and before paper-vector generation.
- Use structured `title`, `author_last`, and `year` from the summary call.
- Keep `extract_metadata()` only as fallback.
- Save `summary` into `PaperRecord`.

### 1.5 Change Paper Vector Construction

Update the ingest flow so:

- Chunk vectors are still created and stored unchanged for chat/Q&A.
- Paper vector becomes the embedding of `title + summary` when a summary exists.
- Chroma paper-vector metadata includes `summary`.
- `VectorStore.query_papers()` continues to work with the same API but now searches better paper-level vectors.

Fallback vector behavior:

- If summarization fails, use front matter only.
- Use chunks 0-3.
- Exclude text after the first line matching `^\s*(references|bibliography)\b`, case-insensitive.
- Normalize the resulting mean vector.

### 1.6 Add Revector Migration

Update `scripts/bulk_ingest.py` with `--revector`.

Required behavior:

- Iterate existing papers from `PaperStore` and Chroma.
- Load cached OCR through `OCRService.extract()` so sidecar cache is reused.
- Run `SummaryService` per paper.
- Embed `title + summary` or fallback front matter.
- Upsert only the paper vector and paper-vector metadata.
- Update `PaperRecord` metadata and summary.
- Do not touch the chunk collection.
- End with normal recluster, tree naming, path assignment, store save, and filesystem rebuild.
- Preserve `--dry-run` as non-writing.
- Preserve `--reset` as the destructive full rebuild path, but do not use it for this migration.

## Phase 2: Silhouette-Driven Tree Shape

All primary algorithm changes live in `backend/clustering/hierarchical.py`.

### 2.1 Fix Ward Linkage Distance

Current behavior feeds cosine distances into Ward linkage. Ward requires Euclidean distances.

New behavior:

- Normalize the vector matrix to unit rows once.
- Compute `pdist(matrix, metric="euclidean")`.
- Use `linkage(distances, method="ward")`.

On normalized vectors, Euclidean distance preserves cosine ordering, so the clustering semantics remain aligned with current intent.

### 2.2 Add Silhouette Split Selection

Add dependency in `pyproject.toml`:

- `scikit-learn`

Replace `_choose_k()` with direct candidate evaluation:

- For each node with `n > MIN_LEAF_SIZE`, evaluate `k` from `2` through `min(BRANCH_MAX, n // MIN_LEAF_SIZE)`.
- Build labels with `fcluster(Z, k, criterion="maxclust")`.
- Skip candidates where any child has fewer than `MIN_LEAF_SIZE` papers.
- Score valid candidates with `sklearn.metrics.silhouette_score(matrix, labels, metric="cosine")`.
- Pick the best-scoring candidate.
- Split only if the best silhouette is at least `MIN_SILHOUETTE`, initially `0.08`.

This replaces both the dendrogram gap heuristic and `COHESION_THRESHOLD`.

### 2.3 Cap Leaf Size

Add `MAX_LEAF_SIZE = 14`.

Behavior:

- If the best split fails `MIN_SILHOUETTE` but the node has more than `MAX_LEAF_SIZE` papers, force the best valid split anyway.
- Continue to reject splits that create children below `MIN_LEAF_SIZE`.
- Keep `MIN_LEAF_SIZE = 3`, `MAX_DEPTH = 6`, and `BRANCH_MIN/MAX = 2/7` unless empirical testing proves they need tuning.

### 2.4 Extract Outliers into Misc

After building the tree:

- Walk leaves.
- Skip leaves with fewer than `MIN_LEAF_SIZE + 1` papers.
- Compute leaf centroid and member cosine similarity to centroid.
- Extract a paper when both conditions are true:
  - `sim < leaf_mean_sim - 2 * leaf_std`
  - `sim < 0.55`
- Collect extracted papers into a synthetic top-level `ClusterNode(name="Misc")`.
- Do not send `Misc` through the LLM namer.
- Do not create singleton folders outside `Misc`.

### 2.5 Preserve Public Cluster API

Keep these contracts unchanged:

- `ClusterNode.name`
- `ClusterNode.paper_ids`
- `ClusterNode.children`
- `ClusterNode.is_leaf`
- `ClusterNode.all_paper_ids()`
- `ClusterTree = list[ClusterNode]`

Downstream code should not need structural changes beyond handling the possible top-level `Misc` node.

## Phase 3: Single-Call Tree Naming

Primary changes live in `backend/clustering/namer.py` plus call sites in `backend/agents/librarian.py` and `scripts/bulk_ingest.py`.

### 3.1 Add `ClusterNamer.name_tree()`

Add an async method:

```python
async def name_tree(self, tree: ClusterTree, records: Mapping[str, PaperRecord]) -> None:
    ...
```

Responsibilities:

- Walk the tree and assign stable node IDs such as `n0`, `n0.1`, `n0.1.2`.
- Serialize leaves with up to 10 paper descriptions.
- Prefer `record.summary`, then `record.title`, then `record.filename`.
- Truncate each description to about 150 chars.
- Serialize internal nodes by child IDs.
- Ask for JSON mapping every node ID to a folder name.

Prompt rules:

- Names must be 2-4 words.
- Names must be Title Case.
- Names must avoid punctuation and numbers.
- Sibling names must be distinct.
- Child names should not repeat parent words.
- Avoid generic names like `Machine Learning`, `Deep Learning Methods`, and `Research Papers`.

### 3.2 Validate and Repair Names

After parsing:

- Sanitize every name with existing `_sanitize()`.
- Check every non-`Misc` node has a non-empty name.
- Check sibling names are unique.
- Check child names do not heavily repeat parent names where possible.

Repair behavior:

- Re-prompt once with only offending node IDs and already-taken sibling names.
- If repair fails, fall back to existing per-node `name_cluster()` for only the bad nodes.
- As final protection, suffix duplicate siblings deterministically: `Foo`, `Foo 2`, `Foo 3`.
- Preserve fixed name `Misc`.

### 3.3 Update Naming Call Sites

Update:

- `LibrarianAgent.reindex()`
- `LibrarianAgent.ingest()`
- `scripts/bulk_ingest.py`

Replace recursive per-node naming loops with one tree-level call after clustering:

```python
await namer.name_tree(tree, records)
```

Keep existing `_name_node()` as fallback support unless implementation proves it is obsolete.

## Rollout Order

Execute in this order:

1. Summary metadata, summary vectors, and Ward distance fix.
2. Silhouette splitting, max leaf size, and `Misc` extraction.
3. Single-call tree naming.
4. Migration with `scripts/bulk_ingest.py --revector`.
5. Empirical quality pass and threshold tuning.

This order matters because better vectors improve clustering, and summaries become better naming input.

## Testing Strategy

The repository currently has no test suite, so tests should be added from scratch under `tests/`.

### Unit Tests: Clustering

Create `tests/test_hierarchical.py`.

Cover:

- Empty input returns an empty tree.
- `n <= MIN_LEAF_SIZE` returns one leaf.
- Synthetic two-topic vectors split into two meaningful branches.
- No child contains fewer than `MIN_LEAF_SIZE` papers.
- Nodes larger than `MAX_LEAF_SIZE` are forced to split when a valid split exists.
- `Misc` extraction pulls only true outliers and does not extract from small leaves.
- Top-level `Misc` remains a normal `ClusterNode` with fixed name.
- Ward path uses Euclidean distances over normalized vectors.

### Unit Tests: Summary Service

Create `tests/test_summarize.py`.

Cover:

- Valid structured LLM JSON parses into title, author, year, and summary.
- Invalid JSON falls back cleanly.
- Missing OpenAI key uses local fallback path.
- Total LLM failure returns fallback metadata and allows vector fallback.
- Input text is trimmed to front matter.
- References or bibliography sections are excluded from fallback paper-vector text.

Mock all external OpenAI and Ollama calls.

### Unit Tests: Naming

Create `tests/test_namer.py`.

Cover:

- `name_tree()` assigns names to every non-`Misc` node.
- `Misc` remains `Misc`.
- Missing node IDs trigger repair or fallback.
- Duplicate sibling names are deduped deterministically.
- Invalid LLM output does not crash reindex.
- `_sanitize()` continues to produce filesystem-safe names.

Mock all LLM calls.

### Integration Tests: Ingest and Reindex

Create `tests/test_librarian_ingest.py`.

Cover with fakes or mocks:

- Ingest stores `summary` in `PaperRecord`.
- Ingest stores `summary` in Chroma paper-vector metadata.
- Chunk embeddings are still added to the chunk collection.
- Paper vector uses summary text when available.
- Paper vector uses front-matter fallback when summarization fails.
- Reindex uses existing paper vectors and names the whole tree once.
- SSE progress event names and shapes are preserved.

### Integration Tests: Bulk Revector

Create `tests/test_bulk_revector.py`.

Cover:

- `--revector` updates existing paper vectors.
- `--revector` updates `PaperRecord.summary`.
- `--revector` does not call chunk upsert or chunk re-embedding.
- `--dry-run --revector` performs no writes.
- Revector ends with recluster, tree naming, path assignment, store save, and filesystem rebuild.

### Vector Store Tests

Create or extend vector store tests with a temporary Chroma directory.

Cover:

- `summary` metadata survives `upsert_paper_vector()`.
- `get_paper_metadata()` returns summary metadata.
- `update_paper_status()` preserves summary metadata.
- `query_papers()` still returns usable paper search results.

### Frontend Checks

No UI behavior should change, but run checks if the frontend type is edited:

```bash
cd frontend
npm run lint
npm run build
```

### Backend Verification Commands

Run after implementation:

```bash
pip install -e ".[dev]"
pytest
```

Optional manual API checks:

```bash
uvicorn backend.main:app --reload --port 8000
curl -N -X POST http://localhost:8000/api/reindex
curl http://localhost:8000/api/tree
curl http://localhost:8000/api/papers
curl http://localhost:8000/api/similarity
```

Optional migration check:

```bash
python scripts/bulk_ingest.py --dry-run
python scripts/bulk_ingest.py --revector
```

Only run the real `--revector` command when the user approves modifying local runtime data.

### Empirical Quality Checks

Add a temporary or committed helper only if useful, likely `scripts/eval_clusters.py`.

It should report:

- Printed cluster tree.
- Per-leaf paper count.
- Per-leaf mean intra-cluster cosine similarity.
- Global silhouette over leaf assignments.
- Duplicate sibling folder names.
- Leaves over `MAX_LEAF_SIZE`.
- Singleton leaves outside `Misc`.
- Papers extracted into `Misc`.

Run it before and after each phase to compare quality.

## Acceptance Criteria

- Existing papers can be migrated with `scripts/bulk_ingest.py --revector` without re-OCRing PDFs or re-embedding chunks.
- Upload flow still completes end-to-end.
- Reindex still emits compatible SSE events.
- Chat/Q&A still works because chunk collection is unchanged.
- Semantic paper search still works and should improve.
- No generated/private files are modified unless explicitly approved.
- No folder has more than `MAX_LEAF_SIZE` papers unless no valid split exists.
- No 1-paper folders are produced outside `Misc`.
- Sibling folders do not silently merge due to duplicate names.
- `pytest` passes.
- Frontend lint and build pass if frontend files are changed.

## Risks and Mitigations

- LLM summary variance: cache summaries in `papers.json` and Chroma metadata, regenerate only through explicit revectoring.
- OpenAI unavailable: fall back to Ollama, then regex/front-matter heuristics.
- Bad silhouette threshold: keep `MIN_SILHOUETTE` as one tunable constant and compare with `eval_clusters.py`.
- Naming collisions: validate names and apply deterministic suffix dedupe before filesystem rebuild.
- Runtime data risk: do not run destructive `--reset`; require user approval before real `--revector` against local data.
- Frontend/API drift: update frontend types when backend response models change.
