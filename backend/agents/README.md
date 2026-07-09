# Backend Agents

Agent layer for chat-driven library actions.

## Components

- `MasterAgent`: uses OpenAI tool calling to route each chat request to one action.
- `OracleAgent`: answers content questions using retrieved Chroma chunks and emits citations.
- `LibrarianAgent`: ingests papers, reclusters the library, rebuilds the symlink tree, and searches papers semantically.
- `StatusAgent`: resolves a paper by semantic search and marks it `read` or `toread`.

All chat-facing agents emit server-sent events expected by the frontend client.

## External Services

- OpenAI is used for chat routing and paper-content responses.
- Ollama is used indirectly through services for embeddings and cluster naming.
- Chroma and the paper store provide retrieval context and metadata.
