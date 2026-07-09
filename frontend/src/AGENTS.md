# AGENTS.md

## Source Rules

- Keep stateful data loading near `App.tsx` unless a component owns a clearly isolated interaction.
- Prefer existing component patterns and Tailwind utility style over introducing a new styling system.
- Keep mobile and desktop behavior in sync; the app intentionally renders different layouts for `lg` and smaller screens.
- Do not add broad memoization by default; follow existing React patterns unless there is a measured need.
- Update `api/client.ts` first when changing backend contracts, then update consumers.
