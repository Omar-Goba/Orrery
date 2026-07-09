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

install_backend() {
  if ! command -v uv >/dev/null 2>&1; then
    die "uv is required for backend installs. Install uv, then run 'make install-backend'."
  fi
  run_quiet "install backend packages with uv" bash -lc "cd '$BACKEND_DIR' && uv sync --extra dev"
}

install_frontend() {
  run_quiet "install frontend packages" npm --prefix "$ROOT/frontend" install
}

banner "Installing Packages"
case "$SERVICE" in
  backend) install_backend ;;
  frontend) install_frontend ;;
  all) install_backend; install_frontend ;;
esac
