# Unified Backlog
Updated: 2026-02-13 (audited against current codebase)

Status legend:
- `Done`: implemented in app code (may still require production rollout/config).
- `Partial`: substantial implementation exists, but core pieces are missing.
- `Open`: not implemented yet.
- `Ops`: operational/deployment work outside app code.

This backlog was re-audited item-by-item against the repository (frontend, backend, prediction-engine, tests).

## Priority 0 - Critical (launch blockers)
- `Partial + Ops` Password reset + recovery flow:
  backend routes/service/worker + frontend screens/cancel UX + tests are present.
  Remaining launch work is operational: run prod migrations, set strong secrets, and complete DNS/rDNS + DKIM/DMARC + prod worker verification.
- `Done` Account deletion (GDPR/CCPA):
  soft-delete/anonymization flow + password-confirm UI + backend test coverage are present.
- `Partial + Ops` Prediction engine access control:
  token guard is implemented in backend and prediction-engine, but prediction-engine explicitly disables auth when token is unset.
  Launch requirement remains: set `PREDICTION_ENGINE_AUTH_TOKEN` in deployed env/config.
- `Done` Admin auth guard for weekly assignment routes:
  admin-only route guards are applied, with self-only restrictions for per-user status endpoint.

## Priority 1 - High impact
- `Partial` Community market question validation + incentives:
  backend routes/migration/tests are implemented, but frontend submission/review/reward UX is still missing.
- `Done` Attachments storage:
  local disk storage + JWT-gated downloads are implemented for posts/messages.
  Presign endpoints exist as scaffold for later object-storage migration.
- `Done` Home feed infinite scroll:
  cursor pagination + frontend virtualization/windowed rendering are implemented.
- `Partial` Tiered verification (phone + payment):
  phone + Stripe SetupIntent flows, verification middleware, webhook route, and `VerificationSettings` UI exist.
  Remaining risk is env/provider readiness in deployment (Twilio/Stripe keys/webhook config).
- `Partial` PWA foundation:
  service worker exists (currently push-focused), but manifest/offline page/install prompt/offline caching are not fully implemented.
- `Open` MLS key rotation UX:
  low-level `selfUpdate()` exists, but no periodic scheduler and no manual "Refresh Keys" settings UI found.
- `Partial` MLS staged-welcome inspection UI:
  pending invite accept/reject exists, but member fingerprint inspection before acceptance is still missing.
- `Partial` Market lifecycle tests:
  resolved-market rejection is covered in prediction-engine integration tests, but explicit closed-market rejection integration coverage is still missing.

## Priority 2 - Medium
- `Partial` Profile editing:
  username + bio editing exists; avatar/display-name/visibility settings are still missing.
- `Open` Two-factor auth (TOTP):
  no TOTP setup/login/backup-code flow found.
- `Partial` Passkey PRF vault unlock:
  WebAuthn/passkey management exists, but PRF flow is incomplete (`getPrfInput()` placeholder still returns `null`).
- `Open` MLS proposal wrappers:
  `propose_add_member`, `propose_remove_member`, `propose_self_update`, `add_members_without_update`, `self_update_with_new_signer` wrappers not implemented in app-facing JS.
- `Open` MLS CommitBuilder JS wrapper:
  no general JS wrapper for app-driven multi-proposal/policy commit building.
- `Open` Persistent message dedup across restarts:
  dedup logic remains in-memory; no vault-backed processed-ID persistence found.
- `Done` AI moderation pipeline:
  Pangram service + flagged-content admin API/UI + `AiContentBadge` integration are present.
- `Open` Moderation/reporting/blocking basics:
  no local report endpoint/admin review workflow/block-user baseline found.
- `Open` Investigate MLS WASM concurrency issue:
  no dedicated issue doc/worklog found in repo; only small mitigation comments.

## Priority 3 - Longer-term
- `Done` Mobile navigation overhaul:
  mobile header/hamburger, bottom nav, and responsive touch-target CSS are present.
- `Partial` Enhanced offline + push notifications + background sync:
  push notifications are implemented; offline caching and background sync are still missing.
- `Open` Messaging UX upgrades:
  reactions, message edit/delete, read receipts, and disappearing messages not implemented.
- `Partial` Advanced social features:
  follow system exists; sharing/boosting and social groups remain open.
- `Partial` Prediction analytics + user insights dashboards:
  scoring/calibration APIs exist; dedicated analytics dashboard UX is still missing.
- `Partial` Performance/scaling work:
  some DB/index and feed-performance work is done, but infra hardening and CI/CD remain open.

## Source References
- `next-steps.md`
- `production-checklist.md`
- `mobile-pwa-plan.md`
- `e2ee-next-steps.md`
- `docs/mls-status.md`
- `Intellacc Feature Roadmap.md`

## Audit Notes
- This pass validates repository/app implementation state, not production runtime state.
- Any item marked `Ops` should be tracked with deployment checklists and env verification.
