# Clustering Improvement Swarm Plan

This document describes how to orchestrate a swarm of `@general` subagents to implement the clustering improvement plan accurately and quickly.

## Swarm Principles

- Use `@general` agents for implementation work and verification work.
- Keep `@explore` for read-only repository investigation when context would otherwise become noisy.
- Assign clear file ownership to reduce merge conflicts.
- Make each agent return concise implementation notes, touched files, test coverage, and blockers.
- Do not let multiple agents edit the same file at the same time unless one is explicitly downstream of the other.
- Preserve existing runtime data and private files.
- Do not run destructive commands or real data migrations without explicit user approval.

## Global Constraints for Every Agent

Every agent must follow these constraints:

- Do not read or modify `.env`.
- Do not modify generated/runtime paths unless explicitly approved:
  - `.venv/`
  - `frontend/node_modules/`
  - `frontend/dist/`
  - `__pycache__/`
  - `*.pyc`
  - `*.ocr.json`
  - `dbs/chroma/`
  - `dbs/papers.json`
  - `dbs/output/`
  - `bulk_ingest_errors.jsonl`
- Preserve SSE event shapes for upload, chat, and reindex.
- Preserve `PaperStatus` values: `read` and `toread`.
- Preserve `ClusterNode` and `ClusterTree` public API.
- Mock OpenAI and Ollama in tests.
- Run targeted tests for owned changes when feasible.

## Agent Roles

### Agent 1: Architecture Lead

Role:

- Own the final interface decisions and sequencing.
- Confirm implementation order and shared contracts before coding agents begin.
- Resolve cross-agent conflicts.

Primary files:

- `plan.md`
- `swarm.md`
- No production code unless resolving integration conflicts.

Responsibilities:

- Define the expected `SummaryService` API.
- Define how records are passed into `ClusterNamer.name_tree()`.
- Define the `--revector` behavior and safety rules.
- Confirm which settings are added to `backend/config.py` and `.env.example`.
- Confirm acceptance criteria before QA.

Dependencies:

- None.

Outputs:

- A short interface contract for all agents.
- A conflict map listing files with expected multi-agent edits.

### Agent 2: Summary and Metadata Agent

Role:

- Implement structured paper summaries and metadata extraction as the primary path.

Primary files:

- `backend/services/summarize.py`
- `backend/models.py`
- `backend/config.py`
- `.env.example`
- `frontend/src/api/client.ts` if the API type mirrors `PaperRecord`

Responsibilities:

- Add `summary` to `PaperRecord`.
- Add summary/naming model settings.
- Implement `SummaryService` with OpenAI primary, Ollama fallback, and heuristic fallback.
- Reuse or preserve existing regex metadata extraction as fallback.
- Ensure old records without `summary` still load.
- Add focused tests for parsing and fallback behavior if assigned by Testing Agent or if scope allows.

Dependencies:

- Depends on Agent 1 for interface contract.

Blocks:

- Agent 3: Ingestion and Revector Agent.
- Agent 5: Tree Naming Agent, because naming uses summaries as input.

Handoff:

- Provide exact import path and method signature for `SummaryService`.
- Document return shape and fallback behavior.
- List settings names and defaults.

### Agent 3: Ingestion and Revector Agent

Role:

- Wire summaries into ingest, bulk ingest, and migration.

Primary files:

- `backend/agents/librarian.py`
- `scripts/bulk_ingest.py`
- Any small shared helper module approved by Agent 1

Responsibilities:

- Use `SummaryService` in upload ingest.
- Use `SummaryService` in bulk ingest.
- Generate paper vectors from `title + summary`.
- Keep chunk embedding behavior unchanged.
- Store `summary` in `PaperRecord` and Chroma metadata.
- Implement front-matter fallback vector.
- Add `scripts/bulk_ingest.py --revector`.
- Preserve `--dry-run` as non-writing.
- Ensure `--revector` does not modify chunk vectors.
- Preserve reindex/upload progress event shape.

Dependencies:

- Depends on Agent 2 for `SummaryService`, model fields, and settings.
- Coordinates with Agent 5 for the eventual `name_tree()` call-site replacement.

Blocks:

- Testing Agent integration tests for ingest and revector.
- Verification Agent migration dry-run checks.

Handoff:

- Summarize changed ingest order.
- Confirm which paths write summary metadata.
- Confirm `--revector` safety behavior.

### Agent 4: Clustering Algorithm Agent

Role:

- Implement the tree-shape improvements.

Primary files:

- `backend/clustering/hierarchical.py`
- `pyproject.toml`

Responsibilities:

- Add `scikit-learn` dependency.
- Normalize vector matrix before Ward linkage.
- Use Euclidean distances with Ward.
- Replace `_choose_k()` with silhouette-based split evaluation.
- Add `MIN_SILHOUETTE`.
- Add `MAX_LEAF_SIZE` forced split behavior.
- Add post-build outlier extraction into top-level `Misc`.
- Preserve `ClusterNode` and `ClusterTree` public shape.
- Keep existing recursive depth and branch constraints unless tests prove otherwise.

Dependencies:

- Depends on Agent 1 for acceptance criteria.
- Can run in parallel with Agent 2 after shared contracts are set.

Blocks:

- Agent 5 for final `Misc` naming behavior.
- Testing Agent clustering unit tests.

Handoff:

- Document new constants and their initial values.
- Document exact `Misc` extraction behavior.
- Provide synthetic examples used during local testing.

### Agent 5: Tree Naming Agent

Role:

- Replace isolated per-node naming with coordinated full-tree naming.

Primary files:

- `backend/clustering/namer.py`
- `backend/agents/librarian.py` call sites after Agent 3 is ready
- `scripts/bulk_ingest.py` call sites after Agent 3 is ready

Responsibilities:

- Implement `ClusterNamer.name_tree(tree, records)`.
- Assign stable node IDs.
- Serialize leaf descriptions using summary, title, then filename.
- Prompt for JSON name mapping.
- Validate all node IDs are named.
- Validate sibling uniqueness.
- Preserve fixed `Misc` name.
- Re-prompt once for invalid or duplicate names.
- Fall back to existing `name_cluster()` for failed nodes.
- Apply deterministic suffix dedupe as final protection.
- Replace call sites with one tree-level naming call.

Dependencies:

- Depends on Agent 2 for `summary` field.
- Depends on Agent 4 for `Misc` convention.
- Coordinates with Agent 3 for shared edits in `backend/agents/librarian.py` and `scripts/bulk_ingest.py`.

Blocks:

- Testing Agent naming tests.
- Verification Agent filesystem duplicate-name checks.

Handoff:

- Document prompt format and validation behavior.
- List fallback paths.
- Confirm duplicate sibling folder names are impossible before filesystem rebuild.

### Agent 6: Testing Agent

Role:

- Add focused automated tests for the new behavior.

Primary files:

- `tests/test_hierarchical.py`
- `tests/test_summarize.py`
- `tests/test_namer.py`
- `tests/test_librarian_ingest.py`
- `tests/test_bulk_revector.py`
- Optional vector store tests with temporary Chroma path

Responsibilities:

- Build tests around pure logic first.
- Mock OpenAI, Ollama, filesystem writes, and Chroma where needed.
- Verify fallback paths do not crash.
- Verify `--revector` does not touch chunks.
- Verify duplicate names are repaired or deduped.
- Verify oversized leaves and `Misc` behavior.
- Keep tests deterministic.

Dependencies:

- Depends on Agent 2 for summary service implementation.
- Depends on Agent 3 for ingest/revector implementation.
- Depends on Agent 4 for clustering behavior.
- Depends on Agent 5 for naming behavior.

Blocks:

- Verification Agent final `pytest` pass.

Handoff:

- Report exact tests added.
- Report any skipped tests and why.
- Report fixtures/mocks that future agents should reuse.

### Agent 7: Verification and QA Agent

Role:

- Run final checks and inspect implementation quality.

Primary files:

- No production ownership by default.
- May add a small `scripts/eval_clusters.py` only if requested or already planned by Agent 1.

Responsibilities:

- Run `pytest`.
- Run frontend lint/build if frontend files changed.
- Run targeted import checks if dependency changes were made.
- Inspect git diff for accidental generated/private file changes.
- Confirm `--reset` was not used.
- Confirm real `--revector` was not run without approval.
- Optionally run dry-run commands.
- Perform manual quality review of cluster constraints where data is available.

Dependencies:

- Depends on all implementation agents and Testing Agent.

Blocks:

- Final delivery.

Handoff:

- Report commands run and results.
- Report residual risks.
- Report any manual checks not run.

## Dependency Graph

```text
Agent 1: Architecture Lead
        |
        +--> Agent 2: Summary and Metadata
        |           |
        |           +--> Agent 3: Ingestion and Revector
        |           |
        |           +--> Agent 5: Tree Naming
        |
        +--> Agent 4: Clustering Algorithm
                    |
                    +--> Agent 5: Tree Naming

Agent 6: Testing depends on Agents 2, 3, 4, and 5.
Agent 7: Verification and QA depends on Agents 2, 3, 4, 5, and 6.
```

## Parallel Execution Strategy

### Wave 0: Exploration

Spawn `@explore` only if more repository context is needed.

Prompt shape:

```text
Explore the repository for the clustering improvement implementation. Do not edit files. Focus on the current APIs, call sites, test structure, and constraints. Return concise findings with file paths and risks.
```

### Wave 1: Contract and Independent Foundations

Run first:

- Agent 1: Architecture Lead.

Then run in parallel:

- Agent 2: Summary and Metadata Agent.
- Agent 4: Clustering Algorithm Agent.

Reason:

- Agent 2 and Agent 4 mostly touch disjoint files.
- Clustering does not need summary service implementation to proceed.

### Wave 2: Wiring and Naming

Run after Agent 2 completes:

- Agent 3: Ingestion and Revector Agent.

Run after Agent 2 and Agent 4 complete:

- Agent 5: Tree Naming Agent.

Important coordination:

- Agent 3 and Agent 5 both may touch `backend/agents/librarian.py` and `scripts/bulk_ingest.py`.
- Prefer Agent 3 edits first for summary/revector wiring.
- Agent 5 edits second for naming call-site replacement.

### Wave 3: Tests

Run after implementation agents complete:

- Agent 6: Testing Agent.

Testing Agent should request clarification only if implementation behavior conflicts with `plan.md`.

### Wave 4: Verification

Run last:

- Agent 7: Verification and QA Agent.

QA Agent should not make broad fixes. If checks fail, route targeted fixes back to the owning implementation agent or make a minimal fix only when ownership is clear.

## Suggested `@general` Prompts

### Architecture Lead Prompt

```text
You are Agent 1, Architecture Lead. Review CLUSTERING_IMPROVEMENT_PLAN.md, plan.md, and swarm.md. Do not implement production code unless resolving a tiny contract issue. Produce the final implementation contracts for SummaryService, ClusterNamer.name_tree, --revector behavior, new settings, and shared acceptance criteria. Identify file conflict risks between agents. Return concise handoff notes.
```

### Summary and Metadata Prompt

```text
You are Agent 2, Summary and Metadata Agent. Implement summary persistence and structured metadata support. Touch only backend/services/summarize.py, backend/models.py, backend/config.py, .env.example, and frontend/src/api/client.ts if needed. Add SummaryService with OpenAI primary, Ollama fallback, and heuristic fallback. Keep old PaperRecord JSON compatible. Mock external calls in any tests you add. Return files changed, API signature, settings added, and tests run.
```

### Ingestion and Revector Prompt

```text
You are Agent 3, Ingestion and Revector Agent. Wire SummaryService into backend/agents/librarian.py and scripts/bulk_ingest.py. Paper vectors should use title + summary when available, fallback to front matter if summarization fails, and chunk embeddings must remain unchanged. Add --revector to scripts/bulk_ingest.py without touching chunks and keep --dry-run non-writing. Preserve SSE event shapes. Return changed files, ingest order, revector behavior, and tests run.
```

### Clustering Algorithm Prompt

```text
You are Agent 4, Clustering Algorithm Agent. Update backend/clustering/hierarchical.py and pyproject.toml. Fix Ward to use Euclidean distances over normalized vectors. Replace k selection with silhouette_score over valid candidate splits. Add MIN_SILHOUETTE, MAX_LEAF_SIZE forced splitting, and post-build Misc outlier extraction. Preserve ClusterNode and ClusterTree API. Return constants, algorithm details, and tests run.
```

### Tree Naming Prompt

```text
You are Agent 5, Tree Naming Agent. Implement ClusterNamer.name_tree in backend/clustering/namer.py and update naming call sites after ingest/revector wiring is present. Name the whole tree in one LLM call using summaries, validate node coverage and sibling uniqueness, preserve Misc, repair once, fall back to name_cluster, and suffix dedupe as final protection. Return prompt format, fallback behavior, files changed, and tests run.
```

### Testing Prompt

```text
You are Agent 6, Testing Agent. Add deterministic tests for clustering, summary service, naming, ingest/reindex wiring, vector metadata, and bulk --revector behavior. Mock OpenAI, Ollama, Chroma, and filesystem where needed. Do not modify generated runtime data. Return tests added, commands run, failures fixed, and remaining coverage gaps.
```

### Verification Prompt

```text
You are Agent 7, Verification and QA Agent. Run final checks for the clustering improvement implementation. Run pytest. If frontend files changed, run npm run lint and npm run build from frontend. Inspect git diff for accidental private/generated file changes. Confirm no destructive reset or real revector was run without approval. Return command results, residual risks, and any failed checks with owning agent recommendations.
```

## File Ownership Matrix

| File | Primary Agent | Secondary Agent |
|------|---------------|-----------------|
| `backend/services/summarize.py` | Agent 2 | Agent 6 |
| `backend/models.py` | Agent 2 | Agent 6 |
| `backend/config.py` | Agent 2 | Agent 7 |
| `.env.example` | Agent 2 | Agent 7 |
| `frontend/src/api/client.ts` | Agent 2 | Agent 7 |
| `backend/agents/librarian.py` | Agent 3 | Agent 5 |
| `scripts/bulk_ingest.py` | Agent 3 | Agent 5 |
| `backend/clustering/hierarchical.py` | Agent 4 | Agent 6 |
| `pyproject.toml` | Agent 4 | Agent 7 |
| `backend/clustering/namer.py` | Agent 5 | Agent 6 |
| `tests/` | Agent 6 | Owning implementation agents |

## Conflict Avoidance Rules

- Agent 3 edits `backend/agents/librarian.py` and `scripts/bulk_ingest.py` before Agent 5.
- Agent 5 must read Agent 3 changes before modifying call sites.
- Agent 6 must not rewrite implementation unless fixing an obvious testability issue.
- Agent 7 must not perform broad refactors during verification.
- If a shared file has unexpected edits, the downstream agent must inspect and adapt rather than overwrite.

## Final Swarm Completion Checklist

- `SummaryService` exists and has tested fallback paths.
- `PaperRecord.summary` is optional and backward compatible.
- Summary metadata is stored in Chroma paper-vector metadata.
- Ingest uses summary vectors when available.
- `--revector` exists and does not re-embed chunks.
- Ward linkage uses Euclidean distances over normalized vectors.
- Silhouette splitting replaces the old k heuristic.
- Oversized leaves are capped where valid splits exist.
- `Misc` outlier extraction works and is not renamed.
- `name_tree()` names the full tree and prevents sibling duplicates.
- Upload, reindex, search, chat, status toggle, and filesystem rebuild still work.
- `pytest` passes.
- `npm run lint` and `npm run build` pass if frontend files changed.
- No private or generated files were modified.
