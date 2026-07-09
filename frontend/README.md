# Frontend

React, TypeScript, Vite, and Tailwind UI for the Project Library app.

## What It Does

- Shows the generated semantic folder tree from the backend.
- Renders a paper graph and cluster legend from indexed paper metadata.
- Provides an Agent Portal for chat, semantic paper lookup, status updates, and PDF upload.
- Streams chat, upload, and reindex progress through backend SSE endpoints.

## Setup

Run commands from this directory:

```bash
npm install
npm run dev
```

The dev server defaults to `http://localhost:5173`. The API client currently calls `http://localhost:8000`, so run the backend separately or use `make dev` from the repository root.

## Checks

```bash
npm run lint
npm run build
```

`npm run preview` serves the production build locally after `npm run build`.

## Structure

- `src/api/client.ts`: API types, fetch helpers, and SSE parsing.
- `src/App.tsx`: top-level responsive layout for tree, graph, and agent portal.
- `src/components/`: focused UI components for upload, chat, graph, tree, and paper discovery.
- `src/index.css`: Tailwind entrypoint and global layout styles.

Do not edit or commit generated `node_modules/` or `dist/` contents.
