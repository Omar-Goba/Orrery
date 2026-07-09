# Frontend Source

Main application source for the Vite frontend.

## Structure

- `main.tsx`: React entrypoint.
- `App.tsx`: responsive application shell with desktop three-column layout and mobile panel navigation.
- `api/`: backend API types, fetch helpers, and SSE stream parsing.
- `components/`: UI for the semantic tree, graph, upload flow, and agent portal.
- `index.css`: Tailwind imports, global dark theme basics, scrollbar styling, and viewport handling.

The frontend depends on backend event shapes for upload, chat, status updates, and reindex progress.
