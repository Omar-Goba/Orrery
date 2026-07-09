# AGENTS.md

## API Client Rules

- Keep TypeScript interfaces aligned with `backend/models.py` and emitted SSE events in `backend/main.py` and `backend/agents/`.
- Preserve discriminated SSE event `type` values unless all frontend consumers are updated.
- If changing `BASE`, check CORS settings in `.env.example` and backend config.
- Keep fetch helpers small and explicit; avoid hiding endpoint-specific behavior behind a generic client unless the app grows enough to need it.
