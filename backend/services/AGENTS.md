# AGENTS.md

## Service Rules

- Treat services as reusable backend infrastructure; keep API-specific response formatting in `backend/main.py` or agents.
- Do not hardcode model names, API keys, or paths; read them from `backend.config.settings`.
- Preserve Chroma collection names and metadata keys unless migration/cleanup is part of the task.
- Keep filesystem operations defensive: preserve real PDFs when rebuilding `dbs/output/`, and avoid destructive changes outside configured runtime paths.
- Do not commit or edit generated `*.ocr.json`, Chroma files, or generated output symlinks unless explicitly requested.
