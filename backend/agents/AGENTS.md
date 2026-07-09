# AGENTS.md

## Agent Rules

- Keep tool-routing behavior in `MasterAgent` explicit; if adding a route, update the tool schema, system instructions, backend handling, and frontend event handling as needed.
- Agent stream methods should yield complete SSE strings using the existing JSON event shapes.
- Do not let the Oracle answer beyond retrieved excerpts; preserve citation behavior and honest fallback semantics.
- Reuse `paper_store`, `EmbeddingService`, `VectorStore`, and `FilesystemService` rather than duplicating persistence logic.
- Status-changing behavior must keep `paper_store`, Chroma metadata, and filesystem symlinks in sync.
