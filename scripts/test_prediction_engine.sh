#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/prediction-engine/docker-compose.test.yml"

if [[ "${1:-}" == "--full" ]]; then
  export CARGO_TEST_ARGS="-- --nocapture"
else
  export CARGO_TEST_ARGS="--lib -- --nocapture --skip stress::tests::test_comprehensive_market_simulation"
fi

cleanup() {
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" up --build --abort-on-container-exit --exit-code-from prediction-engine-tests prediction-engine-tests
