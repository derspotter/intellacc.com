#!/bin/bash
# Zero-downtime frontend deploy: build in a one-shot container, then rsync the
# result into Caddy's static site dir (Caddy serves it directly — there is no
# long-running frontend container). --delay-updates/--delete-delay keep the
# swap near-atomic so a request during deploy never sees a half-updated tree.
set -euo pipefail

cd /var/opt/docker/intellacc.com
SITE_DIR=/var/opt/docker/caddy/site/intellacc

docker compose run --rm frontend-solid

if [ ! -f frontend-solid/dist/index.html ]; then
  echo "[deploy-frontend] build produced no dist/index.html — aborting" >&2
  exit 1
fi

rsync -a --delay-updates --delete-delay frontend-solid/dist/ "$SITE_DIR/"

BUNDLE=$(grep -oE 'assets/index-[^"]+\.js' "$SITE_DIR/index.html" | head -1 || true)
echo "[deploy-frontend] $(date '+%F %T') deployed ${BUNDLE:-unknown bundle}"
echo "[deploy-frontend] verify: https://intellacc.com (NOT localhost:4174 — that is the dev container)"
