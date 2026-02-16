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
- Use explicit env flags to require providers in production:
  - `REQUIRE_TWILIO_VERIFICATION=true`
  - `REQUIRE_STRIPE_VERIFICATION=true`

## Stability hardening (next pass)
- Stripe webhook:
  - confirm idempotency and unknown event handling in `backend/src/controllers/verificationController.js`
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

## Acceptance criteria
- Protected routes consistently enforce the expected minimum tier.
- Verification status/upgrade flow is clear and deterministic.
- Production starts cleanly when required verification provider flags are satisfied.
- Incomplete provider config in production fails fast only when explicitly required.
