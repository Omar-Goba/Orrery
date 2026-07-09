# Scripts

Maintenance scripts for local library data and Makefile-backed development tasks.

## Makefile Wrappers

The root `Makefile` exposes these shell scripts with quiet, colorful defaults.
Command stdout is hidden during everyday use while stderr stays visible. Use `V=1`
with Make recipes or `-v` when calling scripts directly to see full command output.

```bash
make dev
make dev SERVICE=backend
make install
make lint
make test
make reindex
```

`make -v` is reserved by Make itself, so verbose recipe mode is `V=1`.

## Bulk Ingest

`bulk_ingest.py` indexes existing PDFs from configured runtime folders.

```bash
python scripts/bulk_ingest.py
python scripts/bulk_ingest.py --dry-run
python scripts/bulk_ingest.py --reset
python scripts/bulk_ingest.py --revector
```

`--dry-run` previews work without API calls or writes. `--reset` deletes Chroma data and `dbs/papers.json` before rebuilding, so use it only when intentionally recreating the index. `--revector` refreshes paper-level vectors and summaries without re-embedding chunks.

Errors are appended to generated `bulk_ingest_errors.jsonl`.
