# AGENTS.md

## Script Rules

- Keep scripts runnable from the repository root unless documenting otherwise.
- Do not add destructive behavior without an explicit flag and clear README warning.
- Preserve `--dry-run` behavior as non-writing and non-destructive.
- Treat `bulk_ingest_errors.jsonl` as generated runtime output, not source.
- Do not read or expose `.env`; load settings through existing configuration paths.
