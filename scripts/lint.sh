#!/usr/bin/env bash

set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
source "$ROOT/scripts/_lib.sh"

SERVICE="all"
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    *) SERVICE="$arg" ;;
  esac
done
SERVICE="$(normalize_service "$SERVICE")"
[[ "$SERVICE" == "both" ]] && SERVICE="all"

lint_backend() {
  local py
  py="$(python_bin)"
  run_quiet "backend python compile check" "$py" -m py_compile \
    "$ROOT/backend/agents/librarian.py" \
    "$ROOT/backend/clustering/hierarchical.py" \
    "$ROOT/backend/clustering/namer.py" \
    "$ROOT/backend/config.py" \
    "$ROOT/backend/main.py" \
    "$ROOT/backend/models.py" \
    "$ROOT/backend/services/embeddings.py" \
    "$ROOT/backend/services/filesystem.py" \
    "$ROOT/backend/services/ocr.py" \
    "$ROOT/backend/services/summarize.py" \
    "$ROOT/backend/services/vectorstore.py" \
    "$ROOT/backend/store.py" \
    "$ROOT/backend/tests/test_hierarchical.py" \
    "$ROOT/backend/tests/test_namer.py" \
    "$ROOT/backend/tests/test_summarize.py" \
    "$ROOT/scripts/bulk_ingest.py"
}

lint_frontend() {
  run_quiet "frontend lint" npm --prefix "$ROOT/frontend" run lint
}

banner "Linting"
case "$SERVICE" in
  backend) lint_backend ;;
  frontend) lint_frontend ;;
  all) lint_backend; lint_frontend ;;
esac
