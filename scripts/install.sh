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
  run_quiet "install backend packages" bash -lc "cd '$ROOT' && \"$(python_bin)\" -m pip install -e '.[dev]'"
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
