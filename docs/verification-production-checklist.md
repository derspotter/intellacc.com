# Verification Tiers Production Checklist

## Security/configuration preflight
- Copy values from environment and confirm placeholders are not in use:
  - `JWT_SECRET`
  - `EMAIL_TOKEN_SECRET`
  - `PASSWORD_RESET_SECRET`
  - `SMTP_HOST`
  - `SMTP_FROM`
- Confirm `FRONTEND_URL` is HTTPS and not localhost.
- Confirm `PASSWORD_RESET_DELAY_HOURS` is a positive number.

## Provider readiness
Set the following based on what you want to support in production:
- `REQUIRE_TWILIO_VERIFICATION=true` if phone verification is required.
- `REQUIRE_STRIPE_VERIFICATION=true` if payment verification is required.
- `PHONE_VERIFICATION_ENABLED=true|false` to make tier-2 verification optional (`false` disables phone and bypasses phone-gated routes).
- `PAYMENT_VERIFICATION_ENABLED=true|false` to make tier-3 verification optional (`false` disables payment and bypasses payment-gated routes).

Recommended defaults for a no-cost rollout:
- `PHONE_VERIFICATION_ENABLED=false`
- `PAYMENT_VERIFICATION_ENABLED=false`

If enabled:
- Twilio:
  - `TWILIO_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_VERIFY_SID`
- SMS Gateway (self-hosted Android gateway; primary SMS path):
  - `SMS_GATEWAY_URL` (for example `http://100.x.y.z:8080` or `.../message`)
  - `SMS_GATEWAY_USERNAME`
  - `SMS_GATEWAY_PASSWORD`
  - Optional:
    - `SMS_GATEWAY_TIMEOUT_MS`
    - `PHONE_CODE_TTL_MINUTES`
    - `PHONE_CODE_MAX_ATTEMPTS`
    - `PHONE_CODE_HASH_SALT`
- WhatsApp fallback via OpenClaw (optional, used only when SMS send fails):
  - `OPENCLAW_URL` (wss endpoint)
  - `OPENCLAW_TOKEN`
  - Optional:
    - `OPENCLAW_CLI_BIN` (default `openclaw`; set to `npx` with `OPENCLAW_CLI_ARGS='-y openclaw'` if needed)
    - `OPENCLAW_CLI_ARGS`
    - `OPENCLAW_TIMEOUT_MS`
- Stripe:
  - `STRIPE_SECRET_KEY`
  - `STRIPE_PUBLISHABLE_KEY`
  - `STRIPE_WEBHOOK_SECRET`

## Runtime checks
- Start logs show production config validation success:
  - `[ProductionGuard] Production configuration checks passed`
- Verification endpoints are reachable:
  - `GET /api/verification/status` (authenticated)
  - `POST /api/verification/payment/setup` (Tier 2 user or admin role as desired)
  - `POST /api/webhooks/stripe`

## End-to-end smoke test
- Register a fresh user, open mail link, confirm Tier 1 unlock.
- For Tier 2/3 (if enabled), run the flow using a real device and confirm tier upgrades in settings.
- Verify protected actions still return `Higher verification required` with upgrade metadata for lower tiers.
- Backend verification regression tests:
  - `docker exec intellacc_backend npm test -- production_guard.test.js verification.test.js --runInBand`
