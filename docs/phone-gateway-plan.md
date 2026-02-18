# Phone Verification as a Gateway (Optional) — Plan

## Goal
Offer a low-cost optional phone-gated workflow that can be:
- turned on in low-friction mode (no external costs), or
- turned on as a stronger anti-abuse gate later,
without code changes.

## Current state
- Phone verification flow already exists end-to-end (start + confirm + verification state + middleware gates for tier-2 actions).
- Feature availability is now controlled by `PHONE_VERIFICATION_ENABLED` in backend services.
- Middleware is able to bypass phone-dependent restrictions when the feature is disabled.

## Implementation approach

### 1) Make phone gateway explicit in config
- Add a documented runtime switch in deployment config:
  - `PHONE_VERIFICATION_ENABLED=true|false` (default `true` in code to preserve current behavior).
- When `false`, phone verification endpoints (`/api/verification/phone/*`) return:
  - `400` with `Phone verification is disabled by configuration.`
- When `false`, all tier-2 middleware checks should be non-blocking, so phone gating is not enforced by the app.

### 2) UI behavior for disabled mode
- Keep the verification settings page.
- Show a clear informational block when phone is disabled:
  - "Phone verification is disabled by configuration."
  - Actions stay visible for optional later enablement.
- Do not force a hard "complete this step" path when disabled.

3) Optional gateway policy (future)
- Define when to require phone:
  - **Always off** (default): all tiers above email can be used without phone.
  - **Optional for high-risk actions**: only require phone for new accounts, bulk posting, or suspicious traffic.
  - **On demand**: offer phone verification as a button when user enters trust threshold.
- This can be added behind a separate `PHONE_GATEWAY_MODE` enum later (`off | frictionless | trust-score | always`) without changing core routes.

### 4) Fraud/abuse controls while optional
Without phone:
- Keep existing rate limits for high-impact endpoints:
  - post creation, prediction actions, direct messages, event creation.
- Add lightweight risk checks for:
  - account age
  - device trust (existing vault/device verification signals)
  - posting velocity and repeated failures.
- When risk is high, return a normal actionable upgrade prompt to `/#settings/verification` (phone if enabled, otherwise alternative challenge).

### 5) Rollout plan
1. Ship env toggle + middleware bypass (code-level optionality).
2. Update deployment templates and checklist docs.
3. Add automated coverage for both modes:
   - disabled: 4xx endpoints for `/api/verification/phone/*`, non-blocking tier-2 actions.
   - enabled: normal 403 `required_tier` flows.
4. Add a smoke test in prod checklist:
   - with `PHONE_VERIFICATION_ENABLED=false`, verify `/api/verification/status` and at least one tier-2 protected action succeeds.

## Suggested next step
- Implement this behind `PHONE_VERIFICATION_ENABLED` only (already available) and ensure all required env docs/checklists explicitly mention that flag as the production toggle for optional phone verification.
