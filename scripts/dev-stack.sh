#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.local.yml"
ALLOW_PRODUCTION="${INTELLACC_ALLOW_PROD_STACK_OVERLAP:-0}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dev-stack.sh up [extra docker compose args]
  ./scripts/dev-stack.sh down [extra docker compose args]
  ./scripts/dev-stack.sh logs [extra docker compose args]
  ./scripts/dev-stack.sh status

Set INTELLACC_ALLOW_PRODUCTION=1 to run this command while production containers are running.
EOF
}

has_running_container() {
  local name="$1"
  docker ps --filter "name=^/${name}$" --format '{{.Names}}' | grep -Fxq "$name"
}

ensure_not_running_on_production() {
  local collision=0

  if has_running_container intellacc_backend || \
     has_running_container intellacc_frontend || \
     has_running_container intellacc_db || \
     has_running_container intellacc_prediction_engine; then
    collision=1
  fi

  if [ "$collision" -eq 1 ] && [ "$ALLOW_PRODUCTION" != "1" ]; then
    echo "Refusing to start local stack because production containers are running:"
    docker ps --filter "name=^/(intellacc_backend|intellacc_frontend|intellacc_db|intellacc_prediction_engine)$" \
      --format '  {{.Names}} ({{.Status}})'
    echo
    echo "If you know this is expected, run with INTELLACC_ALLOW_PRODUCTION=1."
    exit 1
  fi
}

main() {
  local cmd="${1:-up}"
  shift || true

  case "$cmd" in
    up|start)
      ensure_not_running_on_production
      docker compose -f "$COMPOSE_FILE" up -d --build "$@"
      ;;
    down)
      docker compose -f "$COMPOSE_FILE" down "$@"
      ;;
    logs)
      docker compose -f "$COMPOSE_FILE" logs "$@"
      ;;
    status)
      docker compose -f "$COMPOSE_FILE" ps "$@"
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      echo "Unknown command: $cmd"
      usage
      exit 1
      ;;
  esac
}

main "$@"
