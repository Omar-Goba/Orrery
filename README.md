# Project Library

Local paper/library management app for ingesting PDFs, extracting text, embedding content, clustering papers into a navigable library, and chatting with the indexed collection.

## Architecture

- `backend/`: FastAPI service. It stores paper metadata in `dbs/papers.json`, persists vectors in Chroma under `dbs/chroma/`, builds a symlink library under `dbs/output/`, and exposes REST/SSE endpoints under `/api/*`.
- `backend/agents/`: OpenAI-routed agents for answering paper-content questions, finding papers semantically, and changing read/to-read status.
- `backend/services/`: OCR, embedding, vector-store, and filesystem helpers used by the API and ingestion scripts.
- `frontend/`: React, TypeScript, Vite, and Tailwind UI for the semantic tree, graph view, upload flow, and agent portal.
- `scripts/`: Maintenance scripts, currently including bulk ingestion for existing PDFs.

## Environment

Create `.env` from the checked-in template and fill in local values:

```bash
cp .env.example .env
```

Do not commit or expose `.env`. The template documents the required variable names for OpenAI, Ollama, paths, server port, and CORS origins.

## Backend Setup

Use Python 3.12 or newer from the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Or use the Makefile:

```bash
make install-backend
```

Run the API:

```bash
uvicorn backend.main:app --reload --port 8000
```

Backend tests can be run with `pytest` when test files exist. The `dev` extra installs `pytest` and `pytest-asyncio`; this repository currently has no test files.

## Frontend Setup

Run commands from `frontend/`:

```bash
npm install
npm run dev
```

Or use the Makefile:

```bash
make install-frontend
```

Frontend checks:

```bash
npm run lint
npm run build
```

`npm run preview` serves the production build locally after `npm run build`.

## Full Local Development

From the repository root:

```bash
make dev
```

This starts the backend at `http://localhost:8000` and the frontend at `http://localhost:5173`.

Start only one side with `make dev SERVICE=backend` or `make dev SERVICE=frontend`.
Use `V=1` for verbose command stdout, for example `make lint V=1`.

Warning: `make dev` kills any process already listening on port `8000` before starting the backend.

## Data And Runtime Files

Runtime data lives under `dbs/`:

- `dbs/input/`: original PDFs accepted by the app.
- `dbs/output/`: generated symlink tree organized by semantic clusters.
- `dbs/chroma/`: generated Chroma vector database.
- `dbs/papers.json`: generated paper metadata store.

Generated or private files should not be committed or edited unless a task explicitly requires it: `.venv/`, `frontend/node_modules/`, `frontend/dist/`, `__pycache__/`, `*.pyc`, `*.ocr.json`, `dbs/chroma/`, `dbs/papers.json`, `dbs/output/`, and `bulk_ingest_errors.jsonl`.

Use care with `scripts/bulk_ingest.py --reset`; it deletes Chroma data and `dbs/papers.json` before rebuilding.
