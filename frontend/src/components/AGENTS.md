# AGENTS.md

## Component Rules

- Preserve existing dark, compact UI language and Tailwind utility approach.
- Keep upload, chat, reindex, and status-update progress responsive to SSE events.
- When rendering streamed text, continue escaping untrusted content before applying minimal markdown behavior.
- Keep paper status display labels aligned with backend values: `read` and `toread`.
- Check both desktop and mobile layouts after changes to shared components.
