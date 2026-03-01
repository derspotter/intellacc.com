#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "[check-mls-dedup] $1" >&2
  exit 1
}

echo "[check-mls-dedup] verifying MLS core/wasm de-duplication..."

duplicate_core_files=(
  "frontend/src/services/mls/coreCryptoClient.js"
  "frontend-solid/src/services/mls/coreCryptoClient.js"
)

for path in "${duplicate_core_files[@]}"; do
  if [[ -f "$path" ]]; then
    fail "duplicate core client still exists: $path"
  fi
done

shared_core="shared/mls/coreCryptoClient.js"
[[ -f "$shared_core" ]] || fail "missing shared core client: $shared_core"

duplicate_wasm_files=(
  "frontend-solid/src/pkg/openmls-wasm/openmls_wasm.js"
  "frontend-solid/src/pkg/openmls-wasm/openmls_wasm_bg.wasm"
)

for path in "${duplicate_wasm_files[@]}"; do
  if [[ -f "$path" ]]; then
    fail "duplicate wasm binding still exists: $path"
  fi
done

canonical_wasm_js="frontend/openmls-pkg/openmls_wasm.js"
canonical_wasm_bin="frontend/openmls-pkg/openmls_wasm_bg.wasm"
[[ -f "$canonical_wasm_js" ]] || fail "missing canonical wasm JS binding: $canonical_wasm_js"
[[ -f "$canonical_wasm_bin" ]] || fail "missing canonical wasm binary: $canonical_wasm_bin"

echo "[check-mls-dedup] OK"
