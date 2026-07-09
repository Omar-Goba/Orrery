# Frontend Components

UI components for the library experience.

## Components

- `AgentPortal.tsx`: combined chat, semantic lookup, status update, and inline PDF upload UI.
- `PaperGraph.tsx`: visual network/cluster view for indexed papers.
- `TreeView.tsx`: generated semantic library tree.
- `Upload.tsx`: standalone PDF upload flow with progress.
- `Oracle.tsx` and `Finder.tsx`: older focused chat/search interfaces retained in source.

Components expect the API client types and SSE events from `src/api/client.ts`.
