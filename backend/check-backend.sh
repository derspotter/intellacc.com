#!/usr/bin/env bash
set -e

cd /usr/src/app
# keep base image lean and avoid stale mounts: don't mount node_modules
npm ls --depth=0 >/dev/null 2>&1 || {
  echo "Installing backend dependencies"
  npm install --no-fund --no-audit
}

npm run test -- --runInBand
