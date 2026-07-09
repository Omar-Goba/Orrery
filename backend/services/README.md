# Backend Services

Reusable services for ingestion and retrieval.

## Components

- `ocr.py`: extracts text from PDFs with `pypdf` and caches sidecar files named `*.ocr.json`.
- `embeddings.py`: calls local Ollama for embeddings and normalizes paper-level vectors.
- `vectorstore.py`: wraps persistent Chroma collections for chunks and paper vectors.
- `filesystem.py`: creates the generated semantic symlink tree under `dbs/output/` and serves tree JSON.

These services are used by both API flows and bulk ingestion scripts.

## Runtime Outputs

- OCR sidecars are generated next to PDFs and should not be committed.
- Chroma data under `dbs/chroma/` is generated.
- `dbs/output/` is rebuilt from metadata and clustering results.
