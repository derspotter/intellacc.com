# Unified Backlog
Updated: 2026-02-26 (audited against current codebase)

Status legend:
- `Done`: implemented in app code (may still require production rollout/config).
- `Partial`: substantial implementation exists, but core pieces are missing.
- `Open`: not implemented yet.
- `Ops`: operational/deployment work outside app code.

This backlog was re-audited item-by-item against the repository (frontend, backend, prediction-engine, tests).

## Priority 0 - Critical (launch blockers)
- `Done` Password reset + recovery flow:
  backend routes/service/worker + frontend screens/cancel UX + tests are present.
  Production hardening is now also wired through startup validation and an ops checklist:
  `docs/password-reset-production-checklist.md`.
- `Done` Account deletion (GDPR/CCPA):
  soft-delete/anonymization flow + password-confirm UI + backend test coverage are present.
- `Done` Prediction engine access control:
  token guard is enforced in both backend and prediction-engine.
  Prediction engine now hard-fails startup when `PREDICTION_ENGINE_AUTH_TOKEN` is missing, and backend continues to pass `x-engine-token` on all calls.
- `Done` Admin auth guard for weekly assignment routes:
  admin-only route guards are applied, with self-only restrictions for per-user status endpoint.

## Priority 1 - High impact
- `Done` Community market question validation + incentives:
  backend + frontend are wired end-to-end (submission, review queue, my-submissions, admin reward sweep trigger),
  with config-aware bond/rules display and API integration.
  Implemented backend rules: 5 validators, 4/5 approvals required, creator bond 10 RP plus +5 RP per concurrent pending submission,
  validator stake 2 RP with 5 RP payout to winning-side validators, and creator rewards +10 RP for approval, +10 RP for traction,
  and +10 RP for resolution. Automatic reward runner endpoint: `/api/market-questions/rewards/run`.
- `Done` Attachments storage:
  local disk storage + JWT-gated downloads are implemented for posts/messages.
  Presign endpoints exist as scaffold for later object-storage migration.
- `Done` Home feed infinite scroll:
  cursor pagination + frontend virtualization/windowed rendering are implemented.
- `Partial` Tiered verification (phone + payment):
  email, phone, and payment flows plus middleware and UI exist.
  Production readiness is mostly present via feature-flagged provider validation and docs/checklist:
  `docs/verification-implementation-plan.md`, `docs/verification-production-checklist.md`.
  Phone verification now supports Twilio or self-hosted SMS gateway, with optional OpenClaw WhatsApp fallback on SMS send failure,
  plus server-side OTP challenge persistence (TTL + max-attempt controls).
  Remaining risk is production-e2e coverage (automated user-level flow for webhooks + provider staging checks).
  Backend blocks provider-unavailable starts in production and exposes provider availability + requirements in status payload.
- `Done` PWA foundation:
  manifest, Apple touch icons, and offline caching via Stale-While-Revalidate service worker are implemented.
- `Open` MLS key rotation UX:
  low-level `selfUpdate()` exists, but no periodic scheduler and no manual "Refresh Keys" settings UI found.
- `Partial` MLS staged-welcome inspection UI:
  pending invite accept/reject exists, but member fingerprint inspection before acceptance is still missing.
- `Done` Market lifecycle tests:
  backend coverage now verifies closed-market and resolved-market trade rejection in `/api/events/:eventId/update` plus open-market pass-through behavior.
- `Done` Controlled onboarding with admin approval:
  registration flow supports admin-gated user onboarding, single-use approval tokens, approval queue capacity limits, resend cooldowns, stale/expired token handling, and front-end pending-registration UX.
  Covered by route/service tests and email notification plumbing.

## Priority 2 - Medium
- `Partial` Profile editing:
  username + bio editing exists; avatar/display-name/visibility settings are still missing.
- `Open` Two-factor auth (TOTP):
  no TOTP setup/login/backup-code flow found.
- `Done` Passkey PRF vault unlock:
  WebAuthn/passkey management now persists PRF seed input, uses server-verified PRF output in passkey login responses, and supports local PRF unlock flow.
- `Open` MLS proposal wrappers:
  `propose_add_member`, `propose_remove_member`, `propose_self_update`, `add_members_without_update`, `self_update_with_new_signer` wrappers not implemented in app-facing JS.
- `Open` MLS CommitBuilder JS wrapper:
  no general JS wrapper for app-driven multi-proposal/policy commit building.
- `Done` Persistent message dedup across restarts:
  vault-backed processed-ID persistence created using IndexedDB.
- `Done` AI moderation pipeline:
  Pangram service + flagged-content admin API/UI + `AiContentBadge` integration are present.
- `Done` OpenMLS integration surface cleanup:
  core commit/pending-commit paths are consolidated and API wrappers are de-duplicated; `api.mls` now exposes only active messaging endpoints and messaging-focused e2e coverage is wired with single worker to avoid non-determinism.
- `Done` Moderation/reporting/blocking basics:
  local report endpoint, admin report review workflow, and block-user baseline are implemented.
- `Done` Investigate MLS WASM concurrency issue:
  fixed by serializing vault setup and key package upload in auth sequence.

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
- `docs/email-plan.md`
- `backend/test/registration_approval.test.js`

## Audit Notes
- This pass validates repository/app implementation state, not production runtime state.
- Any item marked `Ops` should be tracked with deployment checklists and env verification.
