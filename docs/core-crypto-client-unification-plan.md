# Core Crypto Client Unification Plan

## Goal

Use one canonical MLS core crypto client implementation for both frontends (Van skin and Solid skin), with no duplicated `coreCryptoClient` logic and no duplicated OpenMLS wasm JS binding.

## Scope

In scope:

- `coreCryptoClient` unification across frontend variants.
- OpenMLS wasm binding de-duplication.
- Build/test updates required for safe rollout.

Out of scope:

- Visual skin styling/parity work.
- Feature additions unrelated to MLS client runtime behavior.

## Desired End State

- One shared core crypto client module.
- Both frontends instantiate the same shared client implementation directly.
- No per-frontend forked `coreCryptoClient` logic files.
- One canonical wasm JS binding source used by both frontends.
- CI guardrails preventing duplicate reintroduction.

## Implementation Steps

1. Baseline and branch

- Create a dedicated branch for this refactor.
- Freeze unrelated edits from this branch while unification is in progress.

2. Add shared canonical module

- Create `shared/mls/createCoreCryptoClient.js`.
- Move the canonical logic into this module.
- Export `createCoreCryptoClient(deps)` with injected dependencies:
  - `api`
  - `onMlsMessage`
  - `onMlsWelcome`
  - `loadVaultService`
  - `openmls` init + `MlsClient`

3. Wire both frontends to shared module directly

- Update Van frontend bootstrap to instantiate from shared module.
- Update Solid frontend bootstrap to instantiate from shared module.
- Preserve existing global contract where needed:
  - `window.coreCryptoClient`

4. Remove duplicate frontend-specific core client files

- Delete:
  - `frontend/src/services/mls/coreCryptoClient.js`
  - `frontend-solid/src/services/mls/coreCryptoClient.js`
- Update all imports/usages to shared path.

5. De-duplicate wasm JS binding

- Keep one canonical wasm JS binding source:
  - `frontend/openmls-pkg/openmls_wasm.js`
- Point both frontends to this source (alias/import path).
- Remove duplicate wasm JS file from `frontend-solid`.

6. Preserve required behavior parity

- Ensure DM recovery/rehydration behavior remains available in the shared module.
- Ensure processed-message dedupe behavior remains consistent.
- Ensure confirmation-tag/fork-detection flow remains intact.

7. Add anti-duplication guardrail

- Add script: `scripts/check-mls-dedup.sh`.
- Fail if duplicate core client or duplicate wasm JS binding files exist.
- Run this script in CI and local test pipeline.

## Validation Matrix

1. Backend tests

- `docker exec intellacc_backend_dev sh -lc 'cd /usr/src/app && NODE_ENV=test ALLOW_REGISTRATION=true npm test -- --runInBand'`

2. Frontend unit tests

- `docker exec intellacc_frontend_local_van_dev sh -lc 'cd /app && npx vitest run'`

3. E2E smoke

- `npx playwright test tests/e2e/messaging-v2-smoke.spec.js --reporter=line`

4. Full E2E

- `npx playwright test tests/e2e/*.spec.js --reporter=line`

## Rollout Strategy

1. PR 1: wasm de-dup only (lowest risk).
2. PR 2: core client unification (shared module + delete forks).
3. PR 3: CI dedup guardrail enforcement.

## Risk Controls

- Keep changes mechanically scoped and separable by PR.
- Avoid concurrent functional rewrites while moving files.
- Validate after each PR before starting next.
- If breakage appears, revert only the latest PR rather than rolling back all work.
