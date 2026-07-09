# Backend Clustering

Hierarchical clustering and folder naming for the generated library tree.

## Components

- `hierarchical.py`: recursively clusters paper vectors with scipy linkage and guards against tiny or over-deep clusters.
- `namer.py`: asks local Ollama for concise folder names and sanitizes them for filesystem use.

Clustering output is consumed by the librarian and filesystem services to populate `cluster_path` metadata and rebuild `dbs/output/`.
