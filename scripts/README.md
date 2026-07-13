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

## Docker Volume Backups

`docker-volumes.sh` backs up the complete Compose state directly from Docker's named
volumes. It does not use or depend on the repository's `dbs/` directory.

```bash
./scripts/docker-volumes.sh backup
./scripts/docker-volumes.sh list
./scripts/docker-volumes.sh restore <path-printed-by-list>
```

Backup archives both `orrery_data` (SQLite, metadata, Chroma, OCR cache, and logs) and
`minio_data` (PDF objects). If the Compose project is running, it is stopped to produce
a consistent snapshot and restarted after successful or failed backup cleanup. Bundles
are written under the repository hub's `auxilary/docker-volume-backups/` directory and
contain two compressed archives, a manifest, and SHA-256 checksums.

Restart restores the regular services and replica counts that were running before backup;
Compose may also start their required dependencies. One-off and obsolete orphan containers
are intentionally not recreated.

These bundles contain password hashes, user metadata, and private PDFs. Bundle directories
are created with owner-only permissions; keep `auxilary/` local and do not commit or share
the archives as ordinary project files.

Restore validates checksums before touching Docker. It refuses to overwrite non-empty
volumes unless `--force` is passed, and it never starts containers automatically:

```bash
# Restore over main after deliberately bringing it down.
docker compose down
./scripts/docker-volumes.sh restore <backup-directory> --force
docker compose up -d

# Restore into a separate pair of volumes.
./scripts/docker-volumes.sh restore <backup-directory> --project-name orrery-recovery
docker compose -p orrery-recovery up -d
```

Use `--dry-run` to validate archives and preview either operation without stopping or
creating containers, creating files, pulling images, or changing volumes. Target-volume
contents are inspected only during a real restore. `--no-restart` leaves a running project
stopped after backup. Use `--output-dir` for a non-default backup location.
