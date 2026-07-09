# AGENTS.md

## Backend Rules

- Prefer absolute imports from `backend.*`.
- Keep API request and response contracts in `backend/models.py` and update `frontend/src/api/client.ts` when those contracts change.
- Preserve async FastAPI endpoints and async service calls where the current flow uses them.
- Preserve SSE framing as `data: <json>\n\n` for chat, upload progress, and reindex streams.
- Keep paper statuses limited to `read` and `toread` unless the whole backend/frontend contract is updated.
- Do not read or expose `.env`; use `.env.example` only for variable names.
- Do not edit generated runtime data under `dbs/`, OCR sidecars, Chroma files, or `bulk_ingest_errors.jsonl` unless explicitly requested.

## Verification

- Run `pytest` after backend logic changes when tests exist.
- For API contract changes, also run frontend checks when feasible: `npm run lint` and `npm run build` from `frontend/`.
