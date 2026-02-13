# Password Reset + Recovery Launch Checklist

## Preflight (once, before first deploy)
- Run pending migrations (password reset tables + indexes are included):
  - `docker exec intellacc_backend psql "$DATABASE_URL" -f /usr/src/app/migrations/20260116_add_password_reset_tokens.sql`
  - `docker exec intellacc_backend psql "$DATABASE_URL" -f /usr/src/app/migrations/20260116_add_password_reset_requests.sql`
  - In production startup, migrations are auto-applied from `backend/migrations`.

- Confirm production environment variables are set (no placeholders):
  - `FRONTEND_URL` (must not be localhost)
  - `JWT_SECRET` (random, high-entropy)
  - `EMAIL_TOKEN_SECRET`
  - `PASSWORD_RESET_SECRET`
  - `SMTP_HOST`, `SMTP_FROM` (valid sender)
  - `PASSWORD_RESET_DELAY_HOURS` (positive number)

- Confirm backend logs include:
  - `[ProductionGuard] Production configuration checks passed`

## DNS / SMTP / Deliverability
- SPF + DKIM + DMARC are aligned for `intellacc.com`.
- PTR for sender IP resolves to `mail.intellacc.com` (or your sending hostname).
- Postfix (or equivalent) reachable as `SMTP_HOST` from the backend container.

## Functional Verification
- Visit `#forgot-password`, request a reset, and verify inbound email link opens `#reset-password?token=...`.
- Use a real non-test recipient email.
- Confirm warning/cancellation UX works:
  - Warning requires acknowledge checkbox.
  - Submit form.
  - Status shows pending when non-device-verified flow is used.
  - Signed-in old device can cancel via Settings → Password Reset.

## Production Observability
- Confirm worker is processing delayed requests:
  - Backend log shows `[PasswordReset] Processed X pending reset(s)` periodically.
- Confirm pending request tables remain bounded:
  - At most one pending request per user due to unique partial index.
- Confirm immediate-reset path clears MLS/encrypted data and invalidates prior JWTs in one end-to-end test.

## Test Commands (local)
- `docker exec intellacc_backend npm test -- test/password_reset.test.js --runInBand`
- `docker exec intellacc_frontend sh -lc 'cd /app && npm run test'`
