# Backend

FastAPI backend for the local paper library.

## Responsibilities

- Loads settings from `.env` through `backend/config.py`.
- Stores paper metadata in `dbs/papers.json` through `backend/store.py`.
- Ingests PDFs, extracts text, embeds chunks, stores vectors in Chroma, and rebuilds a generated symlink tree.
- Exposes REST endpoints for papers and tree data, plus SSE streams for chat, upload progress, and reindex progress.

## Run

From the repository root:

```bash
make dev SERVICE=backend
```

Install backend dependencies first if needed:

```bash
cd backend
uv sync --extra dev
```

## Tests

Tests live in `backend/tests/`. From the repository root:

```bash
make test-backend
```

## Key Modules

- `main.py`: app startup, API routes, upload jobs, and SSE streaming.
- `models.py`: Pydantic request/response models shared across endpoints.
- `config.py`: environment-backed settings and runtime paths.
- `store.py`: in-memory paper registry backed by generated JSON.
- `agents/`: chat routing, content answering, semantic lookup, and status updates.
- `services/`: OCR, embeddings, Chroma, and generated filesystem tree handling.
- `clustering/`: hierarchical clustering and folder-name generation.

Runtime data under `dbs/` is generated and should be treated as local state, not source.
