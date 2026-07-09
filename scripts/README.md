# Scripts

Maintenance scripts for local library data.

## Bulk Ingest

`bulk_ingest.py` indexes existing PDFs from configured runtime folders.

```bash
python scripts/bulk_ingest.py
python scripts/bulk_ingest.py --dry-run
python scripts/bulk_ingest.py --reset
```

`--dry-run` previews work without API calls or writes. `--reset` deletes Chroma data and `dbs/papers.json` before rebuilding, so use it only when intentionally recreating the index.

Errors are appended to generated `bulk_ingest_errors.jsonl`.
