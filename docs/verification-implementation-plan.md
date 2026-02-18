# Tiered Verification Implementation Plan

## Status
- Current implementation of tiered verification exists end-to-end (API, middleware, and UI).
- Remaining work is hardening, deployment readiness, and reliability.

## Scope
The implementation should cover three tiers:
1. Tier 1 — Email verification
2. Tier 2 — Phone verification
3. Tier 3 — Payment method verification

## Backend
- Keep existing verification routes and services:
  - `backend/src/routes/api.js`
  - `backend/src/controllers/verificationController.js`
  - `backend/src/services/{email,phone,payment}VerificationService.js`
  - `backend/src/middleware/verification.js`
- Add production readiness checks in:
  - `backend/src/utils/productionGuard.js`

## Planned production behavior
- Email + verification:
  - `EMAIL_TOKEN_SECRET`, `SMTP_HOST`, `SMTP_FROM`
  - Existing password verification guard behavior remains.
- Optional provider requirements:
  - phone verification provider vars (`TWILIO_*`)
  - payment verification provider vars (`STRIPE_*`)
- Runtime feature toggles:
  - `PHONE_VERIFICATION_ENABLED` and `PAYMENT_VERIFICATION_ENABLED` control whether tier-2/3 checks are enforced.
- Use explicit env flags to require providers in production:
  - `REQUIRE_TWILIO_VERIFICATION=true`
  - `REQUIRE_STRIPE_VERIFICATION=true`

## Stability hardening (next pass)
- Stripe webhook:
  - confirm idempotency and unknown event handling in `backend/src/controllers/verificationController.js` via `paymentVerificationService.handleSetupIntentSucceeded`.
- Phone/payment start flows:
  - return clear errors when provider keys are missing or misconfigured.

## Frontend
- Keep the existing settings/verification UI:
  - `frontend/src/components/verification/VerificationSettings.js`
  - `frontend/src/components/verification/VerificationStatus.js`
  - `frontend/src/components/verification/EmailVerification.js`
  - `frontend/src/components/verification/PhoneVerification.js`
  - `frontend/src/components/verification/PaymentVerification.js`
- Keep action messages consistent with 403 `required_tier` payload.

## Tests
- Add/extend backend verification tests in `backend/test/` for:
  - middleware tier errors and payload fields
  - provider-missing behavior in production guard when required flags are set
  - email verification status flow
- Run:
  - `docker exec intellacc_backend npm test`
  - `docker exec intellacc_frontend npm test`
  - targeted Playwright checks for `#settings/verification`

## Provider account plan
- Phone verification provider: Twilio Verify.
  - In production, use Twilio only if you want SMS verification for tier-2 unlocks.
  - Cost model: pay-as-you-go API checks; typically low volume is cheap, but local rates and compliance charges can vary.
- Payment verification provider: Stripe SetupIntents.
  - In production, enable payment verification only when you need tier-3 controls and card-based verification.
  - Costs are mostly payment-network fees and possible processing charges for attached cards; avoid turning this on unless needed.
- Recommended startup configuration:
  - `REQUIRE_TWILIO_VERIFICATION=false`
  - `REQUIRE_STRIPE_VERIFICATION=false`
  - `PHONE_VERIFICATION_ENABLED=false`
  - `PAYMENT_VERIFICATION_ENABLED=false`
  - Keep features hidden/disabled via provider availability messages when providers are not configured.

## Acceptance criteria
- Protected routes consistently enforce the expected minimum tier.
- Verification status/upgrade flow is clear and deterministic.
- Production starts cleanly when required verification provider flags are satisfied.
- Incomplete provider config in production fails fast only when explicitly required.

## Active implementation work
- [x] Block tier-2 and tier-3 verification start/setup flows when providers are missing in production.
- [x] Extend provider status payload with `required` and availability metadata.
- [x] Add backend regression tests for production provider-missing behavior.
- [x] Make phone/payment verification optional via feature toggles and bypass middleware.

## Current work-in-progress
- [x] Surface provider availability in `/api/verification/status` so UI can explicitly handle missing credentials outside dev.
- [x] Show a clear, non-blocking UI state when Phone/Payment verification is temporarily unavailable.
- [x] Add backend tests for status payload and verification routing behavior (including webhook edge cases and missing provider configs).
