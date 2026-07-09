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

start_backend() {
  step "backend dev server"
  activate_venv_if_present
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:8000 | xargs kill -9 2>/dev/null || true
  fi
  if [[ "$VERBOSE" == "1" ]]; then
    (cd "$ROOT" && "$(python_bin)" -m uvicorn backend.main:app --reload --port 8000) &
  else
    local log_file="$ROOT/.backend.dev.log"
    (cd "$ROOT" && "$(python_bin)" -m uvicorn backend.main:app --reload --port 8000 >"$log_file") &
    printf '%sbackend stdout:%s %s\n' "$DIM" "$RESET" "$log_file"
  fi
  PIDS+=("$!")
}

start_frontend() {
  step "frontend dev server"
  if [[ "$VERBOSE" == "1" ]]; then
    (cd "$ROOT/frontend" && npm run dev) &
  else
    local log_file="$ROOT/.frontend.dev.log"
    (cd "$ROOT/frontend" && npm run dev >"$log_file") &
    printf '%sfrontend stdout:%s %s\n' "$DIM" "$RESET" "$log_file"
  fi
  PIDS+=("$!")
}

banner "Launching Dev Mode"
case "$SERVICE" in
  backend) start_backend ;;
  frontend) start_frontend ;;
  all) start_backend; start_frontend ;;
esac

printf '\n%sBackend:%s  http://localhost:8000\n' "$BOLD" "$RESET"
printf '%sFrontend:%s http://localhost:5173\n' "$BOLD" "$RESET"
printf '\n%sPress Ctrl-C to stop spawned processes.%s\n' "$YELLOW" "$RESET"
wait
