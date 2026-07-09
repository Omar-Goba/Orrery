#!/usr/bin/env bash

set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_lib.sh
source "$ROOT/scripts/_lib.sh"

banner "Project Library Makefile"
cat <<EOF
${BOLD}Daily recipes${RESET}
  ${CYAN}make dev${RESET}                 Start backend + frontend dev servers
  ${CYAN}make dev SERVICE=backend${RESET} Start backend only
  ${CYAN}make dev SERVICE=frontend${RESET} Start frontend only
  ${CYAN}make install${RESET}             Install backend + frontend packages
  ${CYAN}make lint${RESET}                Lint/check backend + frontend
  ${CYAN}make test${RESET}                Test backend + frontend
  ${CYAN}make reindex${RESET}             POST /api/reindex to the running backend

${BOLD}Scoped recipes${RESET}
  ${CYAN}make install-backend${RESET}      uv sync --extra dev in backend/
  ${CYAN}make install-frontend${RESET}     npm install
  ${CYAN}make lint-backend${RESET}         Python compile check
  ${CYAN}make lint-frontend${RESET}        npm run lint
  ${CYAN}make test-backend${RESET}         pytest
  ${CYAN}make test-frontend${RESET}        frontend test script if present, otherwise build

${BOLD}Verbose mode${RESET}
  ${CYAN}make lint V=1${RESET}             Show command stdout
  ${CYAN}./scripts/lint.sh all -v${RESET}  Direct script verbose mode

${DIM}Note: 'make -v' is reserved by Make itself, so Make recipes use V=1.${RESET}
EOF
