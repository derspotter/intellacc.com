# Production Readiness Checklist (Expanded)

Scope: play-money prediction market + social feed. No real-money payments.

Assumptions:
- Prediction engine is a private internal service, not exposed to the public internet.
- Email verification is required for posting/messaging.
- E2EE data loss is acceptable with explicit acknowledgment and safe recovery flow.

---

## Critical

### 1) Password reset + recovery (safe flow)
Why: prevents email compromise from wiping E2EE access.
Files: see `forgot-pw.md`.
Status: implemented (pending migrations + env config).
Work:
- Backend migrations: add `password_reset_tokens`, `password_reset_requests`, `users.password_changed_at`.
- Implement password reset service + controller (token, email, delay, cancel).
- Require verified device or passkey for immediate reset; otherwise schedule delayed reset with cancellation window.
- Enforce `acknowledged === true` server-side.
- Invalidate existing JWTs and disconnect sockets after reset.
- Clear user MLS data via migration function and delete `user_master_keys`.
Progress:
- Added migrations: `backend/migrations/20260116_add_password_reset_tokens.sql`,
  `backend/migrations/20260116_add_password_reset_requests.sql`,
  `backend/migrations/20260116_add_password_changed_at.sql`,
  `backend/migrations/20260116_add_clear_user_mls_data.sql`.
- Backend service/controller/routes/rate limits: `backend/src/services/passwordResetService.js`,
  `backend/src/controllers/passwordResetController.js`, `backend/src/routes/api.js`.
- JWT/socket invalidation: `backend/src/middleware/auth.js`, `backend/src/index.js`,
  `backend/src/controllers/userController.js`.
- Frontend pages + wiring: `frontend/src/components/auth/ForgotPasswordPage.js`,
  `frontend/src/components/auth/ResetPasswordPage.js`, `frontend/src/components/auth/LoginForm.js`,
  `frontend/src/router/index.js`, `frontend/src/services/api.js`, `frontend/styles.css`.
Notes:
- Immediate reset requires valid JWT + matching `device_public_id` in `user_devices`.
- Delayed reset executes via background worker in `backend/src/index.js`.
Pending:
- Apply migrations.
- Configure env vars: `PASSWORD_RESET_SECRET`, `PASSWORD_RESET_EXPIRY`, `PASSWORD_RESET_DELAY_HOURS`,
  `PASSWORD_RESET_POLL_INTERVAL_MS`.
Acceptance:
- Email-only reset does not immediately delete keys.
- Reset tokens are single-use and expire.
- Canceling a pending reset works from any authenticated device.
- JWTs issued before `password_changed_at` are rejected.

### 2) Market lifecycle enforcement in engine
Why: prevent trades on closed/resolved events.
Files: `prediction-engine/src/lmsr_api.rs`, `prediction-engine/src/database.rs`.
Status: implemented.
Work:
- Reject `update_market` and `sell_shares` if `events.outcome` indicates resolved.
- Reject trades if `closing_date <= NOW()` (unless explicitly allowed).
- Add tests for closed/resolved trade rejection.
Progress:
- Added resolved/closed checks in `prediction-engine/src/lmsr_api.rs`.
- Added 4xx handling in `prediction-engine/src/main.rs` for resolved/closed errors.
Pending:
- Add tests for closed/resolved trade rejection (integration tests).
Acceptance:
- Trades return 4xx with clear error after close/resolve.
- No market state changes after close/resolve.

### 3) Prediction engine access control
Why: engine endpoints should not be public.
Files: `prediction-engine/src/main.rs`, `prediction-engine/src/config.rs`.
Status: implemented.
Work:
- Add a simple auth guard (shared secret header or internal allowlist).
- Exempt `/health` if needed.
- Document the required header and env var.
Progress:
- Auth guard added in `prediction-engine/src/main.rs` using `x-engine-token` header.
- Backend proxy/header wiring updated in `backend/src/services/scoringService.js`,
  `backend/src/controllers/scoringController.js`, `backend/src/routes/api.js`.
Pending:
- Set `PREDICTION_ENGINE_AUTH_TOKEN` in backend + prediction-engine env.
Acceptance:
- Requests without the token are rejected (401/403).
- Backend proxy passes the token and succeeds.

---

## High

### 4) Attachments storage (presigned URLs)
Why: image/file uploads are stubbed.
Files: `backend/src/controllers/attachmentsController.js`.
Work:
- Implement presign for upload/download in chosen object store (S3/GCS/Azure).
- Validate content type, size, and namespace object keys.
- Decide how posts store `image_url` (public URL vs signed download).
Acceptance:
- Upload URL works end-to-end and image renders in feed.
- Download URL expires and enforces object ownership if required.

### 5) Weekly assignment admin auth
Why: unguarded admin-only routes are exposed.
Files: `backend/src/controllers/weeklyAssignmentController.js`, `backend/src/routes/api.js`.
Work:
- Add admin middleware (role check) for weekly endpoints.
- Add rate limits if needed.
Acceptance:
- Non-admin requests receive 403.
- Admin requests succeed.

### 6) Device-link notifications
Why: device linking is silent for existing devices.
Files: `backend/src/controllers/deviceController.js`, `backend/src/services/pushNotificationService.js`.
Work:
- On pre-login link request, push a notification to existing devices for the user.
- Provide in-app fallback if push not enabled.
Acceptance:
- Existing device receives a link request prompt within seconds.

---

## Medium

### 7) Passkey PRF vault unlock (finish placeholders)
Why: PRF unlock is stubbed.
Files: `frontend/src/services/vaultService.js`, `backend/src/controllers/userController.js` (master key APIs).
Work:
- Implement PRF-based master key wrapping/unwrapping end-to-end.
- Ensure server stores `wrapped_key_prf` and supports updates.
Acceptance:
- User can unlock vault via passkey without password.

### 8) Moderation/reporting/blocking
Why: basic safety for public scale.
Work:
- Add report endpoint + table for abusive content.
- Add block/mute to hide users/content.
- Add simple admin dashboard or admin API for reports.
Acceptance:
- Users can report posts/users; admins can review and act.

---

## Nice-to-have / Ops

### 9) Scheduled jobs
Why: avoid manual scoring/ranking updates.
Files: `prediction-engine/src/main.rs`.
Work:
- Enable periodic Metaculus sync.
- Schedule global rankings updates.
Acceptance:
- Jobs run on schedule and log results.

### 10) Optional engine event stream
Why: admin visibility into background jobs.
Work:
- SSE or WebSocket endpoint for job progress and system events.
Acceptance:
- Admin UI can subscribe and receive job status events.
