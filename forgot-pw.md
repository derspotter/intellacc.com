# Password Reset Implementation Plan (Updated)

## Overview

Implement a safe "Forgot Password" flow with explicit warnings about loss of access to encrypted data. Align with current JWT-only auth, device verification, vault storage, and MLS tables. Prefer recovery delay and verified-device/passkey confirmation to prevent email compromise from destroying E2EE access.

Critical UX requirement: user must acknowledge that password reset will cause:
- Loss of access to encrypted messages on this account
- MLS memberships removed (re-invitation required for private groups)
- MLS key packages removed and local MLS/vault data cleared

Account, public posts, and predictions remain intact.

---

## Safety Model (Recommended)

### Two-tier recovery
1) **Immediate reset (low risk)**
   - Allowed only if a verified device or passkey confirms the reset.
   - Proceed with key deletion + membership removal immediately.

2) **Delayed reset (email-only)**
   - If only email is available, create a recovery request with a delay (e.g., 7 days).
   - Notify all devices and email.
   - Allow cancellation from any authenticated device during the delay.
   - Only after the delay completes, execute destructive steps.

This prevents email compromise from instantly wiping E2EE access.

---

## Database Changes

### 1) New Table: password_reset_tokens

File: backend/migrations/20260116_add_password_reset_tokens.sql

```sql
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_expires ON password_reset_tokens(expires_at) WHERE used_at IS NULL;
```

### 2) New Table: password_reset_requests

File: backend/migrations/20260116_add_password_reset_requests.sql

```sql
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, cancelled, completed
  required_confirmations INT NOT NULL DEFAULT 0,
  confirmed_at TIMESTAMP,
  execute_after TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_password_reset_requests_user ON password_reset_requests(user_id);
CREATE INDEX idx_password_reset_requests_status ON password_reset_requests(status);
```

### 3) Add users.password_changed_at

File: backend/migrations/20260116_add_password_changed_at.sql

```sql
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP DEFAULT NOW();
```

### 4) MLS Cleanup Helper (if not guaranteed in migrations)

File: backend/migrations/20260116_add_clear_user_mls_data.sql

Create or move the clear_user_mls_data(user_id) function from cleanup_user_mls_data.sql into a real migration so it exists in all environments. It should delete only user-specific MLS data:
- mls_welcome_messages (receiver_id or sender_id)
- mls_group_messages (sender_id)
- mls_key_packages (user_id)
- mls_group_members (user_id)
- mls_direct_messages (user_a_id or user_b_id)

Do NOT delete mls_groups or other members' messages.

---

## Backend Implementation

### 1) Password Reset Service

File: backend/src/services/passwordResetService.js

Pattern after emailVerificationService.js:
- generateResetToken(userId, email) -> JWT with PASSWORD_RESET_SECRET and 1h expiry
- hashToken(token) -> SHA-256
- sendPasswordResetEmail(userId, email) -> nodemailer or console fallback
- verifyResetToken(token) -> JWT verify + DB lookup for hash, expiry, unused
- createResetRequest(userId, mode) -> immediate or delayed
- executePasswordReset(userId, newPassword) -> DB transaction

Token storage: hash only; delete prior unused tokens for the user.

### 2) Reset Execution (Single DB Transaction)

Within a DB transaction:
1) Update users.password_hash and users.password_changed_at = NOW()
2) DELETE FROM user_master_keys WHERE user_id = $1
3) SELECT clear_user_mls_data($1) (or inline deletes)
4) Mark password_reset_tokens.used_at = NOW()
5) Update password_reset_requests.status = 'completed'
6) Log event to server logs (or add a security_events table later)

### 3) Controllers and Routes

File: backend/src/controllers/passwordResetController.js

- POST /auth/forgot-password
  - Accept email
  - If user exists, send email
  - Always return success to prevent email enumeration

- POST /auth/reset-password
  - Accept token, newPassword, acknowledged
  - Enforce password length
  - Enforce acknowledged === true
  - If verified device/passkey: execute immediately
  - Else: create delayed reset request and return pending state

- POST /auth/reset-password/cancel
  - Authenticated endpoint to cancel pending reset

File: backend/src/routes/api.js
Add unauthenticated routes with rate limits:
- POST /auth/forgot-password
- POST /auth/reset-password
Add authenticated route:
- POST /auth/reset-password/cancel

### 4) Rate Limiting

Add a dedicated limiter for forgot-password (similar to preLoginRateLimit), and optionally a smaller limit for reset-password.

### 5) Session/Socket Invalidation

Because there are no refresh tokens or session versioning, use password_changed_at:
- Update backend/src/middleware/auth.js to reject tokens where decoded.iat < users.password_changed_at
- Update Socket.IO auth in backend/src/index.js with the same check
- Disconnect sockets immediately after reset completion

### 6) Change Password (Authenticated)

Update userController.changePassword to set users.password_changed_at = NOW().
Option: return a fresh JWT; if not, frontend should force re-login.

---

## Frontend Implementation

### 1) Forgot Password Page

File: frontend/src/components/auth/ForgotPasswordPage.js
Route: #forgot-password
Stages: email -> sending -> sent
Always show success message.

### 2) Reset Password Page

File: frontend/src/components/auth/ResetPasswordPage.js
Route: #reset-password?token=...
Stages: warning -> form -> resetting -> success/error/pending

Warning copy (ASCII):
WARNING: Resetting your password will permanently remove your access to encrypted data.
By resetting, you will lose:
- Encrypted messages in your conversations
- Your MLS keys and group memberships
- You will need to be re-invited to encrypted conversations
This cannot be undone. Your account and public posts remain intact.

Checkbox required; send acknowledged=true in API call.

Pending state for delayed reset:
- Show countdown (execute_after)
- Offer link to cancel from an authenticated device

On success:
- clear auth token
- clear local MLS/vault artifacts on this device:
  - indexedDB.deleteDatabase('intellacc_keystore')
  - localStorage.removeItem('device_public_id') and 'device_id'
- redirect to login

### 3) API Service Updates

File: frontend/src/services/api.js
Add:
- auth.requestPasswordReset(email)
- auth.resetPassword(token, newPassword, acknowledged)
- auth.cancelPasswordReset()

### 4) Router + Login Link

File: frontend/src/router/index.js
Add pages and no-layout entries.

File: frontend/src/components/auth/LoginForm.js
Add "Forgot Password?" link under password field.

---

## MLS Membership Handling

- Do NOT auto re-add user to private groups; re-invite is required.
- Public groups could be rejoined via external commit only if server permits external commits for public groups (future enhancement).

---

## Email Template

Subject: Reset your Intellacc password

Include a prominent warning that reset will remove access to encrypted data and MLS memberships. Link to FRONTEND_URL/#reset-password?token=...

---

## Testing Plan

Manual tests:
1) Forgot password returns success for valid and invalid emails
2) Reset link expires after 1 hour
3) Acknowledgment is required
4) Immediate reset requires verified device/passkey
5) Delayed reset creates pending request and can be cancelled
6) Password updated, user_master_keys removed, MLS tables cleared
7) Old JWTs rejected due to password_changed_at
8) Existing sockets are disconnected
9) Login with new password creates a fresh vault

E2E test: add tests/e2e/password-reset.spec.js covering immediate and delayed flows including token reuse.

---

## Success Criteria

- Reset request does not reveal email existence
- Token is single-use and expires
- Immediate reset gated by verified device/passkey
- Email-only reset is delayed with cancellation
- Password reset invalidates existing JWTs
- user_master_keys removed and MLS memberships cleared
- Warning and acknowledgment are enforced
