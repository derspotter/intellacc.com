# Legacy E2E Quarantine

The following specs are quarantined because they target pre-vault/device-link UI and pre-current MLS bootstrapping behavior:

- `tests/e2e/device-linking.spec.js`
- `tests/e2e/granular-persistence.spec.js`
- `tests/e2e/key-rotation-inspection.spec.js`
- `tests/e2e/messaging-attachment-link.spec.js`
- `tests/e2e/messaging-attachment-ui.spec.js`
- `tests/e2e/messaging-full.spec.js`
- `tests/e2e/safety-numbers.spec.js`

These are currently skipped in Playwright and should be replaced incrementally with v2 flows.

Current replacement baseline:

- `tests/e2e/messaging-v2-smoke.spec.js`
