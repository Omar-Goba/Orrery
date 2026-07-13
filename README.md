# Project Library

Local paper/library management app for ingesting PDFs, extracting text, embedding content, clustering papers into a navigable library, and chatting with the indexed collection.

## Architecture

- `backend/`: FastAPI service and Python module. It owns `backend/pyproject.toml`, `backend/.venv/`, `backend/uv.lock`, backend tests, paper metadata in `dbs/papers.json`, Chroma vectors under `dbs/chroma/`, generated symlink output under `dbs/output/`, and REST/SSE endpoints under `/api/*`.
- `backend/agents/`: OpenAI-routed agents for answering paper-content questions, finding papers semantically, and changing read/to-read status.
- `backend/services/`: OCR, embedding, vector-store, and filesystem helpers used by the API and ingestion scripts.
- `frontend/`: React, TypeScript, Vite, and Tailwind UI for the semantic tree, graph view, upload flow, and agent portal.
- `scripts/`: Maintenance scripts, currently including bulk ingestion for existing PDFs.

## Environment

Create `.env` from the checked-in template and fill in local values:

```bash
cp .env.example .env
```

Do not commit or expose `.env`. The template documents the required variable names for LLM providers, local paths, S3-compatible object storage, and MinIO. Replace the placeholder API keys and local MinIO credentials before starting the application.

## Docker Compose

The complete local stack includes the frontend, backend, private MinIO object storage, and an idempotent bucket initializer. The default configuration uses external OpenAI-compatible LLM services, including `text-embedding-3-small` for startup embedding verification. From the repository root:

```bash
cp .env.example .env
# Configure the required LLM roles and replace the local MinIO credentials.
docker compose up --build
```

Once the services are healthy:

- App: `http://localhost`
- MinIO console: `http://localhost:9001`

The backend, MinIO object API, and Ollama API are available only to containers on the Compose network. They are not published on host ports 8000, 9000, or 11434.

Stop the stack normally with:

```bash
docker compose down
```

Normal shutdown removes the containers and network but preserves the `orrery_data`, `minio_data`, and optional `ollama_data` named volumes. `docker compose down -v` is a destructive reset that deletes those project volumes, including application metadata, uploaded PDFs, vector data, logs, and downloaded Ollama models.

Bundled Ollama is optional. Leave `COMPOSE_PROFILES` empty when using external LLM APIs. To run Ollama, set `COMPOSE_PROFILES=local-llm`, set `LLM_EMBEDDER__BASE_URL=http://ollama:11434/v1`, leave its API key blank, and keep `LLM_EMBEDDER__MODEL` identical to `OLLAMA_EMBED_MODEL`. The profile starts a one-shot initializer that pulls that embedding model before the backend starts. Other local role models must be provisioned separately if configured. A `--profile local-llm` command-line override is also valid, but enabling the profile does not rewrite role URLs.

Nginx accepts request bodies up to `110m`, allowing multipart overhead above the default 100 MiB `ORRERY_MAX_PDF_BYTES`. If the application limit is raised, update `client_max_body_size` in `frontend/nginx.conf` at the same time so valid uploads still reach FastAPI.

## Backend Setup

Use Python 3.12 or newer. Backend dependencies are managed as a module-local uv project:

```bash
cd backend
uv sync --extra dev
```

Or use the Makefile:

```bash
make install-backend
```

Run the API:

```bash
make dev SERVICE=backend
```

Backend tests live under `backend/tests/` and can be run with `make test-backend`.

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

Generated or private files should not be committed or edited unless a task explicitly requires it: `.venv/`, `backend/.venv/`, `frontend/node_modules/`, `frontend/dist/`, `__pycache__/`, `*.pyc`, `*.ocr.json`, `dbs/chroma/`, `dbs/papers.json`, `dbs/output/`, and `bulk_ingest_errors.jsonl`.

Use care with `scripts/bulk_ingest.py --reset`; it deletes Chroma data and `dbs/papers.json` before rebuilding.
