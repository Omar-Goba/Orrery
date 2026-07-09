# AGENTS.md

## Frontend Rules

- Use React function components and TypeScript.
- Preserve the existing dark Tailwind visual language unless a redesign is requested.
- Keep backend API types, endpoint helpers, and SSE parsing in `src/api/client.ts`.
- If backend response shapes or SSE event types change, update `src/api/client.ts` and all affected components together.
- The API base is currently `http://localhost:8000`; change it deliberately and document the reason.
- Do not edit or commit `node_modules/` or `dist/`.

## Verification

- Run `npm run lint` after frontend code changes.
- Run `npm run build` when changes affect TypeScript types, bundling, or API contracts.
