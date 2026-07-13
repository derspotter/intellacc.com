# Unified Backlog
Updated: 2026-07-13 (delta below; last full audit 2026-06-12)

## 2026-07-12/13 Delta
- `Done` Legacy E2E quarantine dissolved: device-linking, key-rotation-inspection,
  granular-persistence, and safety-numbers specs ported to the Solid flows and green.
  Reactivation caught and fixed two production bugs: second-device linking looped on
  LINK_REQUIRED forever (approved device id was never read back), and inviter-side TOFU
  fingerprinting did not exist (only welcome recipients recorded fingerprints).
- `Done` Safety-number verification UI in both skins (DM badge/modal/warning banner,
  group member inspector with per-member verify) — closes the UI half of "MLS
  staged-welcome inspection"; safety numbers derive from leaf signature keys so
  out-of-band comparison matches what peers record.
- `Done` Device-link approval now accepts the short pairing code the modal displays
  (unambiguous prefix match, authenticated + password-confirmed + single-use).
- `Done` Logout locks the vault and wipes MLS keys/decrypted messages in both skins.
- `Done` CI runs an E2E smoke of the E2EE suite on every push (solid-messaging,
  device-linking, safety-numbers, key-rotation-inspection, granular-persistence)
  against a fresh stack; rehearsed green on fresh DB.
- `Done` Phone verification (Tier 2) production smoke (2026-07-13): full live flow
  executed against production — /verification/phone/start dispatched via smsgate,
  real SMS delivered, /verification/phone/confirm accepted the code (also exercised
  the 10-min code expiry and the 3/hour per-number rate limit along the way).
  Account state consistent afterwards. Remaining verification ops item: Stripe
  (Tier 3) still needs staging credentials.

Forward feature plan: `docs/feature-roadmap.md`. Completed plan documents are in `docs/archive/`.

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
  `docs/archive/password-reset-production-checklist.md`.
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
  Decision 2026-06-12: local disk IS the production path for the single-server deployment;
  ensure `backend/uploads/` is part of the host backup routine. Revisit only if scaling out.
- `Done` Home feed infinite scroll:
  cursor pagination + frontend virtualization/windowed rendering are implemented.
- `Partial` Tiered verification (phone + payment):
  email, phone, and payment flows plus middleware, provider guards, and UI are implemented.
  Repository coverage already includes tier progression, provider-unavailable behavior, and Stripe webhook robustness.
  Production readiness is mostly present via feature-flagged provider validation and docs/checklist:
  `docs/archive/verification-implementation-plan.md`, `docs/verification-production-checklist.md`.
  Phone verification supports Twilio or self-hosted SMS gateway, with optional OpenClaw WhatsApp fallback on SMS send failure,
  plus server-side OTP challenge persistence (TTL + max-attempt controls).
  Browser-level payment verification E2E scaffolding exists; remaining work is staging-provider execution with real Stripe/Twilio-or-SMS-gateway config.
  Backend blocks provider-unavailable starts in production and exposes provider availability + requirements in status payload.
- `Done` PWA/install + push foundation:
  manifest, icons, push subscription/preferences, push delivery, and notification-click handling are implemented.
  The service worker intentionally does not intercept fetches or cache the app shell to avoid stale hashed deploys.
- `Done` MLS key rotation UX:
  manual "Refresh Keys" settings UI implemented, tested with Playwright. Periodic scheduler postponed as a stretch goal.
- `Done` MLS staged-welcome inspection UI:
  member fingerprint inspection before acceptance is fully implemented via a modal, tested with Playwright.
- `Done` Market lifecycle tests:
  backend coverage now verifies closed-market and resolved-market trade rejection in `/api/events/:eventId/update` plus open-market pass-through behavior.
- `Done` Controlled onboarding with admin approval:
  registration flow supports admin-gated user onboarding, single-use approval tokens, approval queue capacity limits, resend cooldowns, stale/expired token handling, and front-end pending-registration UX.
  Covered by route/service tests and email notification plumbing.
- `Done` Persuasive Alpha reward settlement:
  attribution, episode/payout schema, scorer service, prediction-engine scoring endpoint, admin run/status routes, and daily cron entrypoint are implemented.
  Verified live 2026-06-12: `POST_SIGNAL_REWARDS_ENABLED=true`, cron shared secret configured
  (timing-safe check), supercronic daily run at 01:00 UTC (100+ clean runs logged), and a manual
  cron-endpoint smoke executed the full pipeline with zero errors. Architecture review: idempotent
  episode/payout creation, single-consume click claims, self-attribution excluded, meaningful-update
  thresholds; NO reward caps by documented policy (kill switch is the only stop).
  Note: the pipeline has never had real attributed traffic (0 episodes ever); watch
  `post_signal_run_logs` and `post_signal_reward_payouts` when the first real
  click-then-trade flows occur.
- `Done` Solid frontend unification/cutover:
  Runtime cutover executed 2026-06-11: gate green, both production domains serve Solid, VanJS containers/images removed.
  VanJS code removed from mainline the same day; preserved at tag `fallback/vanjs-final` and branch `archive/vanjs`.

## Priority 2 - Medium
- `Done` Profile editing:
  username, bio, avatar upload/editing, display-name support, and profile visibility controls are implemented in backend, VanJS, Solid, and tests.
- `Done` Passkey PRF vault unlock:
  WebAuthn/passkey management now persists PRF seed input, uses server-verified PRF output in passkey login responses, and supports local PRF unlock flow.
- `Done` Persistent message dedup across restarts:
  vault-backed processed-ID persistence using IndexedDB; the Solid vaultService gap
  (missing `getRecentProcessedMessages`/`markMessageProcessed`, found 2026-06-11 via the
  solid-messaging E2E spec) was ported from the archived VanJS implementation on 2026-06-12.
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
  push notifications are implemented. Offline app-shell/data caching, offline action queueing, and background sync are not implemented.
- `Done` Messaging UX upgrades:
  MLS-safe message edit/delete, read receipts, and disappearing messages implemented 2026-06-12
  as encrypted in-group control messages (`__mls_type` edit/delete/read_receipt/expiration; no
  backend changes, sender-match authorization for edit/delete on receive, per-message expiry
  stamped at persist time with hard-delete purge on read). Covered end-to-end by the
  solid-messaging E2E spec. Reactions are intentionally out of scope.
- `Done` E2EE onboarding/vault hardening follow-ups (found 2026-06-11 while building the solid-messaging E2E spec, fixed 2026-06-12):
  1. Unlock paths no longer create the server master key as a side effect
     (`getOrCreateMasterKey` gained `createIfMissing: false` for `findAndUnlock`), so a failed
     unlock can no longer demote an account out of implicit first-device trust.
  2. The auto-accept welcome path now acks before `acceptStagedWelcome`, matching the explicit
     accept path, so the confirmation-tag broadcast is sent as a registered group member.
- `Partial` Advanced social features:
  follow system, repost/boost sharing, ActivityPub MVP, ATProto publishing, and ATProto/Mastodon social login exist.
  Remaining work is richer social-graph/product UX, social groups, and production federation hardening.
- `Done` Prediction analytics + user insights dashboards:
  LMSR ledger, history, open-position, and leaderboard data are surfaced through a dedicated solid analytics dashboard,
  with backend aggregation endpoint support for forecasting summary, recent predictions, and current exposure.
- `Partial` Performance/scaling work:
  DB/index and feed-performance work are in place, and runtime stack was upgraded to Node 25 + Postgres 18.
  Remaining work is infra hardening, capacity testing, and CI/CD automation.

- `Done` CI test-environment sensitivity (found and fixed 2026-06-12):
  Root cause: `jest.config.js`'s setupFilesAfterEnv helper (and `test/testServer.js`) required
  `src/index` at module scope, caching the whole app BEFORE each test file's jest.mock factories
  registered — silently disarming mocks in six suites. The production container was accidentally
  shielded because it predates `jest.config.js` (the backend root is not mounted), so jest ran
  with no config there. Fixed by requiring the app lazily in both helpers; all 27 suites now pass
  in a clean environment and the CI skip list is removed. `jest.config.js` is now mounted into
  the backend container so production test runs match CI.

## Recommended Next Execution Order
1. `Verification production smoke`: run Tier 2/Tier 3 staging-provider flows, especially Stripe Elements + webhook upgrade (needs staging credentials).

## Source References
- `docs/feature-roadmap.md` (forward plan)
- `docs/verification-production-checklist.md` (open ops item)
- `docs/archive/` (completed plan documents: Solid cutover, MLS unification,
  Persuasive Alpha implementation, email/phone/password-reset plans, VanJS notes)
- `backend/test/` and `tests/e2e/` (behavioral evidence for Done statuses)

## Audit Notes
- This pass validates repository/app implementation state, not production runtime state.
- Any item marked `Ops` should be tracked with deployment checklists and env verification.
