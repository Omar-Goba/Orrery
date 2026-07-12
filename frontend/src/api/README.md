# Frontend API Client

Typed browser client for the FastAPI backend.

## Contents

- Paper, citation, tree, and SSE event TypeScript interfaces.
- Fetch helpers for listing papers, loading the tree, opening PDFs, updating status, and starting uploads/reindex.
- Streaming helpers for backend SSE responses.

`BASE` comes from `VITE_API_BASE_URL` and defaults to same-origin for Docker/nginx deployments.
