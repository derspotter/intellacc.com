# Unified Backlog
Updated: 2026-01-22

This backlog consolidates open work from `next-steps.md`, `production-checklist.md`,
`mobile-pwa-plan.md`, `e2ee-next-steps.md`, `docs/mls-status.md`, and
`Intellacc Feature Roadmap.md` into a single prioritized view.

## Priority 0 - Critical (launch blockers)
- Password reset + recovery flow: apply migrations, configure env vars, verify worker job and cancellation flow.
- Account deletion (GDPR/CCPA): soft delete + delayed purge with password confirmation.
- Prediction engine access control: set `PREDICTION_ENGINE_AUTH_TOKEN` in backend + engine configs.
- Admin auth guard for weekly assignment routes (backend middleware + route gating).

## Priority 1 - High impact
- Attachments storage: presigned upload/download + metadata table + create-post UI and rendering.
- Tiered verification (phone + payment): ship SMS (Twilio) + Stripe SetupIntent verification flows,
  wire `VerificationSettings` UI, and confirm webhook + env config readiness.
- PWA foundation: manifest, offline caching, install prompt, offline page.
- MLS key rotation UX: periodic `selfUpdate()` + manual "Refresh Keys" in settings.
- MLS staged-welcome inspection UI: view member fingerprints before accept.
- Market lifecycle tests: integration tests for closed/resolved trade rejection.

## Priority 2 - Medium
- Profile editing: avatar, bio, display name, visibility settings.
- Two-factor auth (TOTP): setup + login step + backup codes.
- Passkey PRF vault unlock: finish placeholder flow end-to-end.
- MLS proposal wrappers: `propose_add_member`, `propose_remove_member`, `propose_self_update`,
  `add_members_without_update`, `self_update_with_new_signer`.
- MLS CommitBuilder JS wrapper for multi-proposal commits and policy hooks.
- Persistent message deduplication across restarts (vault-backed IDs).
- AI moderation pipeline: Pangram detection service + flagged content API + admin UI and
  `AiContentBadge` display for AI-likely posts/comments.
- Moderation/reporting/blocking basics (report endpoint + admin review).
- Investigate MLS WASM concurrency issue (`mls-wasm-concurrency-bug.md`).

## Priority 3 - Longer-term
- Mobile navigation overhaul: hamburger + bottom nav, touch targets, responsive layout.
- Enhanced offline + push notifications + background sync (PWA phases 2-4).
- Messaging UX: reactions, editing/deletion, read receipts, disappearing messages.
- Advanced social features: follow system, sharing/boosting, groups.
- Prediction analytics + user insights dashboards.
- Performance/scaling work (DB optimization, infra hardening, CI/CD).

## Source References
- `next-steps.md`
- `production-checklist.md`
- `mobile-pwa-plan.md`
- `e2ee-next-steps.md`
- `docs/mls-status.md`
- `Intellacc Feature Roadmap.md`
