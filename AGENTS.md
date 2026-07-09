# AGENTS.md

## Project Overview

This repository contains a local paper/library management app.

- Backend: FastAPI app in `backend/`.
- Backend agents: OpenAI-routed paper assistant logic in `backend/agents/`.
- Backend services: OCR, embedding, vector-store, and filesystem helpers in `backend/services/`.
- Frontend: React, TypeScript, Vite, and Tailwind app in `frontend/`.
- Local data and runtime files live under `dbs/`.
- Environment configuration is loaded from `.env`; use `.env.example` as the template.

## Do Not Edit Generated Or Private Files

Do not read, expose, modify, or commit secrets from `.env`.

Do not modify or commit generated/runtime dependency files unless explicitly requested:

- `.venv/`
- `backend/.venv/`
- `frontend/node_modules/`
- `frontend/dist/`
- `__pycache__/`
- `*.pyc`
- `*.ocr.json`
- `dbs/chroma/`
- `dbs/papers.json`
- `dbs/output/`
- `bulk_ingest_errors.jsonl`

## Backend Setup

Use Python 3.12 or newer. Backend dependencies are module-local under `backend/`.

```bash
cd backend
uv sync --extra dev
```

Run the backend from the repository root:

```bash
make dev SERVICE=backend
```

Run backend tests, if tests are present:

```bash
make test-backend
```

`pytest` and `pytest-asyncio` are available through the backend `dev` extra. Backend tests live under `backend/tests/`.

## Frontend Setup

Use npm from `frontend/`.

```bash
npm install
npm run dev
```

Frontend checks:

```bash
npm run lint
npm run build
```

## Full Local Development

The Makefile starts both backend and frontend:

```bash
make dev
```

The recipe starts the backend on `http://localhost:8000` and the frontend on `http://localhost:5173`.

Use `make dev SERVICE=backend` or `make dev SERVICE=frontend` to start only one side.

Warning: `make dev` kills any process already listening on port `8000` before starting the backend.

## Backend Conventions

- Use FastAPI async endpoints where appropriate.
- Use Pydantic models from `backend/models.py` for API request and response shapes.
- Prefer absolute imports from `backend.*`.
- Keep environment-specific settings in `backend/config.py` and `.env.example`.
- Avoid hardcoding secrets, API keys, or user-specific absolute paths.
- The vector store and generated library views are local runtime data; treat them as disposable generated outputs unless the user says otherwise.
- Preserve the SSE event shapes emitted by chat, upload, and reindex endpoints unless the frontend client is updated at the same time.
- Keep paper status values aligned with `PaperStatus`: `read` and `toread`.

## Frontend Conventions

- Use TypeScript and React function components.
- Keep API types and fetch helpers in `frontend/src/api/client.ts` when changing backend contracts.
- Preserve the existing dark Tailwind-based visual language unless the user asks for a redesign.
- The frontend currently calls `http://localhost:8000` from `frontend/src/api/client.ts`; update this deliberately if backend addressing changes.
- Run `npm run lint` and `npm run build` after frontend changes when feasible.

## Assistant Workflow

- Prefer small, focused changes.
- Inspect the relevant code before editing; do not assume behavior from file names alone.
- Treat this as a monorepo: backend Python state belongs under `backend/`, frontend Node state belongs under `frontend/`, and root scripts/Makefile only orchestrate modules.
- If changing API models, endpoints, or response shapes, update both backend code and frontend client/types.
- If adding dependencies, update the appropriate manifest and lockfile:
  - Python dependencies: `backend/pyproject.toml` and `backend/uv.lock`.
  - Frontend dependencies: `frontend/package.json` and `frontend/package-lock.json`.
- Keep tests service-level: backend tests live in `backend/tests/`; frontend tests should live under `frontend/` if added.
- Prefer root Make recipes for everyday verification: `make lint`, `make test`, `make dev`, and scoped `SERVICE=backend|frontend` variants.
- Makefile/script output should stay quiet and readable by default, keep stderr visible, and expose full stdout through verbose mode (`V=1` for Make, `-v` for scripts).
- Any long-running recipe or script that spawns child processes must trap Ctrl-C and terminate spawned PIDs.
- Avoid destructive data operations. In particular, `scripts/bulk_ingest.py --reset` deletes Chroma data and `dbs/papers.json`.
- Do not run real migrations such as `scripts/bulk_ingest.py --revector` or destructive resets unless the user explicitly approves local runtime data changes.
- Do not modify generated local data under `dbs/` unless the task explicitly requires it.

## Commit Discipline

- Commit every completed task unless the user explicitly says not to commit.
- Use atomic commits: one coherent change per commit, no mixed unrelated work.
- Before committing, inspect `git status`, `git diff --stat`, and the staged diff.
- Stage only files touched for the current task; leave unrelated user or agent changes unstaged.
- Do not commit generated/private files unless explicitly requested.
- Use this commit message template exactly:

```text
<type>(<scope>): <summary>
<desc that is written in a fun and playful way>
```

- Keep `<type>` conventional and lowercase, such as `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, or `build`.
- Keep `<scope>` short and module-oriented, such as `backend`, `frontend`, `scripts`, `make`, `docs`, or `clustering`.
- Keep `<summary>` imperative and concise.
- Make the description playful but still useful: mention what changed, why it matters, and any verification caveat.
