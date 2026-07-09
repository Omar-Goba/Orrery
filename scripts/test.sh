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

test_backend() {
  local py
  py="$(python_bin)"
  if ! "$py" -m pytest --version >/dev/null 2>&1; then
    die "pytest is not installed for $py. Run 'make install-backend' first."
  fi
  run_quiet "backend tests" bash -lc "cd '$ROOT' && '$py' -m pytest backend/tests"
}

test_frontend() {
  if npm --prefix "$ROOT/frontend" run | grep -q '^  test$'; then
    run_quiet "frontend tests" npm --prefix "$ROOT/frontend" run test
  else
    warn "No frontend test script found; running build as the frontend verification gate."
    run_quiet "frontend build" npm --prefix "$ROOT/frontend" run build
  fi
}

banner "Testing"
case "$SERVICE" in
  backend) test_backend ;;
  frontend) test_frontend ;;
  all) test_backend; test_frontend ;;
esac
