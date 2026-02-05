#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH"
export PLAYWRIGHT_MCP_CONFIG="${PLAYWRIGHT_MCP_CONFIG:-/var/opt/docker/intellacc.com/.playwright-cli/config.json}"

exec playwright-cli "$@"
