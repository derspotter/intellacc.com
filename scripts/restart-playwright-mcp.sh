#!/usr/bin/env bash
set -euo pipefail

echo "Stopping Playwright MCP processes..."
pkill -f "@playwright/mcp" || true
pkill -f "playwright-mcp" || true

echo "Clearing cached MCP browser profiles (safe if MCP is stopped)..."
rm -rf "${HOME}/.cache/ms-playwright/mcp-chrome" \
       "${HOME}/.cache/ms-playwright/mcp-chrome-profile" || true

echo "Done. Restart your MCP client (VS Code/Codex) to launch Playwright MCP with --isolated."
