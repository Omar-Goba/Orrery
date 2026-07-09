#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERBOSE="${VERBOSE:-0}"
PIDS=()

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  MAGENTA=$'\033[35m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD=""
  DIM=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  MAGENTA=""
  CYAN=""
  RESET=""
fi

parse_common_flags() {
  local args=()
  for arg in "$@"; do
    case "$arg" in
      -v|--verbose) VERBOSE=1 ;;
      *) args+=("$arg") ;;
    esac
  done
  printf '%s\n' "${args[@]}"
}

banner() {
  local title="$1"
  printf '\n%s╭────────────────────────────────────────╮%s\n' "$MAGENTA" "$RESET"
  printf '%s│%s %s%-38s%s %s│%s\n' "$MAGENTA" "$RESET" "$BOLD" "$title" "$RESET" "$MAGENTA" "$RESET"
  printf '%s╰────────────────────────────────────────╯%s\n' "$MAGENTA" "$RESET"
}

step() {
  printf '%s◆%s %s%s%s\n' "$CYAN" "$RESET" "$BOLD" "$1" "$RESET"
}

ok() {
  printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"
}

warn() {
  printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2
}

die() {
  printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  exit 1
}

normalize_service() {
  local service="${1:-all}"
  case "$service" in
    all|both|backend|frontend) printf '%s' "$service" ;;
    "") printf 'all' ;;
    *) die "Unknown service '$service'. Use SERVICE=backend, SERVICE=frontend, or SERVICE=all." ;;
  esac
}

cleanup_children() {
  local code=$?
  if ((${#PIDS[@]})); then
    printf '\n%s◆%s stopping spawned processes...\n' "$YELLOW" "$RESET" >&2
    kill "${PIDS[@]}" 2>/dev/null || true
    for pid in "${PIDS[@]}"; do
      pkill -TERM -P "$pid" 2>/dev/null || true
    done
    wait "${PIDS[@]}" 2>/dev/null || true
  fi
  exit "$code"
}

trap cleanup_children INT TERM EXIT

run_quiet() {
  local label="$1"
  shift
  step "$label"
  if [[ "$VERBOSE" == "1" ]]; then
    printf '%s$ %s%s\n' "$DIM" "$*" "$RESET"
    "$@"
  else
    local log_file
    log_file="$(mktemp -t project-library.XXXXXX.log)"
    if "$@" >"$log_file"; then
      ok "$label"
    else
      local status=$?
      warn "stdout saved to $log_file"
      return "$status"
    fi
  fi
}

python_bin() {
  if [[ -x "$ROOT/.venv/bin/python" ]]; then
    printf '%s' "$ROOT/.venv/bin/python"
  else
    printf '%s' "python3"
  fi
}

activate_venv_if_present() {
  if [[ -f "$ROOT/.venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$ROOT/.venv/bin/activate"
  else
    warn "No .venv found; using current Python environment. Run 'make install-backend' first if needed."
  fi
}
