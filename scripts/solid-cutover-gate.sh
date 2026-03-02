#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SOLID_BUILD_IMAGE="${SOLID_BUILD_IMAGE:-node:22-alpine}"
RUN_PLAYWRIGHT="${RUN_PLAYWRIGHT:-0}"
PLAYWRIGHT_CMD="${PLAYWRIGHT_CMD:-npx playwright test tests/e2e/solid-cutover-smoke.spec.js}"

log() {
  echo "[solid-cutover-gate] $*"
}

fail() {
  echo "[solid-cutover-gate] ERROR: $*" >&2
  exit 1
}

run_step() {
  local title="$1"
  shift
  log "STEP: ${title}"
  "$@"
  log "OK: ${title}"
}

run_step "MLS shared-client de-duplication guard" ./scripts/check-mls-dedup.sh

run_step "frontend-solid production build (containerized)" \
  docker run --rm \
    -v "${ROOT_DIR}/frontend-solid:/app" \
    -v "${ROOT_DIR}/shared:/shared" \
    -v "${ROOT_DIR}/frontend:/frontend" \
    -w /app \
    "${SOLID_BUILD_IMAGE}" \
    sh -lc "npm ci --no-audit --no-fund >/tmp/npm-ci.log && npm run build"

if [[ "${RUN_PLAYWRIGHT}" == "1" ]]; then
  export PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:4174}"
  log "Using PLAYWRIGHT_BASE_URL=${PLAYWRIGHT_BASE_URL}"
  run_step "playwright smoke matrix" bash -lc "${PLAYWRIGHT_CMD}"
else
  log "SKIP: Playwright smoke (set RUN_PLAYWRIGHT=1 to enforce UI smoke)."
fi

log "PASS: Solid cutover gate checks completed."
