# WebAuthn + PRF Authentication Plan

## Goal

Replace the current email/password + separate vault passphrase system with:
- **WebAuthn (passkeys)** for authentication
- **PRF extension** for device keystore unlock
- **Password fallback** for universal compatibility
- **Single password experience** - no separate vault passphrase

## Current State

- Email/password login with JWT
- Separate vault passphrase for E2EE key encryption
- Users must remember two passwords
- No WebAuthn support

## Target State

```text
┌─────────────────────────────────────────────────────────┐
│                    Account Login                         │
├─────────────────────┬───────────────────────────────────┤
│   Passkey + PRF     │         Password                  │
│   (preferred)       │         (fallback)                │
├─────────────────────┴───────────────────────────────────┤
│              Local Device Keystore Unlock               │
│  PRF output OR Password-derived key unlocks device key  │
├─────────────────────────────────────────────────────────┤
│             MLS Client (Device) Ready / Linkable        │
│  New device does NOT receive past message history       │
└─────────────────────────────────────────────────────────┘
```

## Architecture

### MLS Client Model (Device = Client)

- In MLS, the unit of membership is a **client** (typically a device).
- A single user/account may own multiple MLS clients (phone, desktop, tablet).
- Each device has its own MLS state stored locally (encrypted at rest).
- A newly added device/client **does not gain access to prior message history** by default.
  - This matches MLS guidance: history restore is not provided by MLS itself.

### Device Linking (Signal-like)

To avoid silent "add a new device" account takeovers:

- Login (password/passkey) authenticates the **account**.
- **Linking** authenticates the **messaging device**.
  - First device on an account is implicitly trusted.
  - Additional devices require explicit approval from an existing trusted device.

Recommended linking UX:
- New device shows a QR code (ephemeral link token).
- Existing trusted device scans and approves.
- Existing trusted device adds the new device MLS client to conversations/groups.

### Delivery Service (Relay Queue, Not an Archive)

Goal: the server is a relay, not a long-term message store.

- When a message is sent, the server enqueues ciphertext for each recipient device in the
  recipient’s **linked device set at send time**.
- Each device fetches its pending ciphertext and sends an acknowledgment (ACK).
- The server deletes the queued ciphertext once all targeted devices ACK delivery.
- Newly linked devices do **not** backfill old ciphertext (no history sync).

Policy knobs:
- Offline retention TTL for undelivered messages (e.g. 30–90 days).
- Device inactivity policy (e.g. revoke devices idle too long).

### Local Device Keystore Structure

This replaces the idea of a cross-device "vault restore". The keystore is **device-local**.

```javascript
{
  id: "device_keystore_{deviceId}", // deviceId is a UUID
  version: 2,

  // Stable identifiers
  userId: number,
  deviceId: string, // UUID (matches user_devices.device_public_id)

  // Random per-device PRF input
  // Stored so PRF is stable on this device without being predictable across users
  prfInput: Uint8Array(32),

  // The actual device key, wrapped two ways
  deviceKeyWrapped: {
    // Always present - password can always unwrap
    password: {
      salt: Uint8Array(32),      // Argon2id salt
      iv: Uint8Array(12),        // AES-GCM IV
      ciphertext: Uint8Array     // Wrapped device key
    },
    // Optional - only if user has PRF-capable passkey on this device
    prf: {
      credentialId: string,      // Which credential wraps this
      iv: Uint8Array(12),
      ciphertext: Uint8Array
    }
  },

  // Device-local MLS persistent state encrypted with device key
  // Note: this is NOT used to restore history across devices.
  encryptedDeviceState: {
    iv: Uint8Array(12),
    ciphertext: Uint8Array
  }
}
```

### Key Derivation

**Password path:**
```text
password + salt → Argon2id → 32 bytes → (HKDF optional) → AES-GCM key → unwrap device key
```

**PRF path:**
```text
passkey auth + prfInput → PRF extension → 32 bytes → (HKDF optional) → AES-GCM key → unwrap device key
```

## Database Schema

```sql
-- WebAuthn credentials for logging into an account
CREATE TABLE webauthn_credentials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id BYTEA NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT[],
  supports_prf BOOLEAN DEFAULT FALSE,
  name TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP
);

CREATE INDEX idx_webauthn_user_id ON webauthn_credentials(user_id);
CREATE INDEX idx_webauthn_credential_id ON webauthn_credentials(credential_id);

-- Linked devices (messaging-capable clients)
CREATE TABLE user_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_public_id UUID NOT NULL UNIQUE, -- The stable ID used in client keystores
  name TEXT,
  is_primary BOOLEAN DEFAULT FALSE, -- The first device or manually promoted one
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE INDEX idx_user_devices_user_id ON user_devices(user_id);

-- Note on mls_key_packages table:
-- The 'device_id' column in mls_key_packages should correspond to 
-- user_devices.device_public_id (as text/string).
-- 
-- CREATE TABLE IF NOT EXISTS mls_key_packages (
--   user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   device_id TEXT NOT NULL, -- Matches user_devices.device_public_id
--   ...
-- );

-- Optional: relay queue (store-and-forward until ACK)
CREATE TABLE message_queue (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  sender_device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  ciphertext BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE TABLE message_queue_recipients (
  queue_id BIGINT NOT NULL REFERENCES message_queue(id) ON DELETE CASCADE,
  recipient_device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  delivered_at TIMESTAMP,
  PRIMARY KEY (queue_id, recipient_device_id)
);

CREATE INDEX idx_message_queue_recipients_device ON message_queue_recipients(recipient_device_id);
```

## Implementation Phases

### Phase 1: Password-Unlocks Keystore (Remove Second Password)

**Goal:** Single password experience - login password unlocks the local device keystore.

**Changes:**

1. **vaultService.js (rename conceptually to keystore)**
   - Add `setupKeystoreWithPassword(password)` - wraps device key with login password
   - Add `unlockWithPassword(password)` - unwraps and unlocks
   - Modify `changePassphrase()` to re-wrap device key only

2. **auth.js**
   - Pass password to keystore unlock during login
   - Auto-setup device keystore on first login on a device

3. **Remove modals**
   - Delete `PassphraseSetupModal.js`
   - Delete `UnlockModal.js`
   - Update components that use them

4. **Password change flow**
   - Backend: Add endpoint that requires old password
   - Frontend: Unwrap device key with old password, re-wrap with new password

**Files to modify:**
- `frontend/src/services/vaultService.js`
- `frontend/src/services/auth.js`
- `frontend/src/components/vault/PassphraseSetupModal.js` (delete)
- `frontend/src/components/vault/UnlockModal.js` (delete)
- `frontend/src/stores/vaultStore.js`
- `backend/src/routes/api.js` (password change endpoint)

### Phase 2: WebAuthn Registration & Login

**Goal:** Add passkey support alongside password for account login.

**Backend changes:**

1. **New routes (`backend/src/routes/webauthn.js`):**
   ```
   POST /api/webauthn/register/options     - Get registration challenge
   POST /api/webauthn/register/verify      - Verify and store credential
   POST /api/webauthn/login/options        - Get authentication challenge
   POST /api/webauthn/login/verify         - Verify assertion, return JWT
   GET  /api/webauthn/credentials          - List user's passkeys
   DELETE /api/webauthn/credentials/:id    - Remove a passkey
   ```

2. **Dependencies:**
   ```
   npm install @simplewebauthn/server
   ```

**Frontend changes:**

1. **New service (`frontend/src/services/webauthn.js`):**
   - `register()` - Register new passkey
   - `login()` - Authenticate with passkey
   - `isAvailable()` - Check browser support

2. **UI components:**
   - Add "Sign in with passkey" button to login page
   - Add "Add passkey" option in settings
   - Passkey management UI (list, delete)

3. **Dependencies:**
   ```
   npm install @simplewebauthn/browser
   ```

**Files to create:**
- `backend/src/routes/webauthn.js`
- `backend/src/services/webauthnService.js`
- `frontend/src/services/webauthn.js`
- `frontend/src/components/auth/PasskeyButton.js`
- `frontend/src/components/settings/PasskeyManager.js`

**Migration:**
- `backend/migrations/YYYYMMDD_add_webauthn_credentials.sql`

### Phase 3: Device Linking + Device Directory

**Goal:** Separate "account authenticated" from "messaging device trusted".

**Important Note:** Until this phase is complete, the application functions effectively as a **single-device** system. Logging in on a new device will create a new disjoint session that cannot communicate with the user's previous sessions or history.

**Backend changes:**

1. **Device directory**
   - Create/list/revoke linked devices for a user.

2. **Device linking routes (recommended):**
   ```
   POST /api/devices/link/start      - New device creates link token / QR payload
   POST /api/devices/link/approve    - Trusted device approves link token
   GET  /api/devices                 - List linked devices
   POST /api/devices/:id/revoke      - Revoke a linked device
   ```

**Frontend changes:**
- New device shows QR code + "Waiting for approval"
- Existing device: scan/approve UI

**Notes:**
- A device that is logged in but not linked can still browse the app, but cannot
  participate in E2EE conversations until linked.

### Phase 4: PRF Integration (Unlock Keystore Without Password)

**Goal:** Use PRF to unlock the local device keystore without typing a password.

**Changes:**

1. **Registration with PRF:**
   ```javascript
   const credential = await navigator.credentials.create({
     publicKey: {
       // ... standard options
       extensions: {
         prf: {}
       }
     }
   });

   const prfSupported = credential.getClientExtensionResults().prf?.enabled;
   ```

2. **Login / unlock with PRF:**
   ```javascript
   const credential = await navigator.credentials.get({
     publicKey: {
       // ... standard options
       extensions: {
         prf: {
           eval: {
             first: prfInput // Uint8Array(32) from local keystore
           }
         }
       }
     }
   });

   const prfOutput = credential.getClientExtensionResults().prf?.results?.first;
   // Use prfOutput to unwrap device key
   ```

3. **Keystore wrapping:**
   - When registering a PRF-capable passkey on a device, also wrap the device key with PRF output.
   - Store `prf` wrapping alongside `password` wrapping.

4. **Fallback handling:**
   - If PRF not available, require password to unlock the device keystore.
   - UI should clearly indicate whether this device can be unlocked with passkey-only.

**Files to modify:**
- `frontend/src/services/webauthn.js` - Add PRF support
- `frontend/src/services/vaultService.js` - Add PRF unwrapping
- `frontend/src/services/auth.js` - Handle PRF unlock flow

### Phase 5: Relay Queue + Edge Cases

**Goal:** Server is a relay, not a long-term message store. Messages deleted after delivery or TTL.

**Schema:**

```sql
-- Relay queue for store-and-forward messaging
CREATE TABLE mls_relay_queue (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_device_id INT NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL,  -- 'application', 'commit', 'welcome'
  data BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days'
);

CREATE TABLE mls_relay_recipients (
  queue_id BIGINT NOT NULL REFERENCES mls_relay_queue(id) ON DELETE CASCADE,
  recipient_device_id INT NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  acked_at TIMESTAMP,
  PRIMARY KEY (queue_id, recipient_device_id)
);

CREATE INDEX idx_relay_pending ON mls_relay_recipients(recipient_device_id) WHERE acked_at IS NULL;
CREATE INDEX idx_relay_expires ON mls_relay_queue(expires_at);
```

**Backend Routes:**

```
POST /api/mls/messages/group     -- Store in relay queue
POST /api/mls/messages/welcome   -- Store in relay queue
GET  /api/mls/queue/pending      -- Get unacked messages for device
POST /api/mls/queue/ack          -- ACK messages, delete if all devices acked
```

**Backend Service (mlsService.js):**

```javascript
async storeRelayMessage(groupId, senderDeviceId, messageType, data) {
  // 1. INSERT INTO mls_relay_queue
  // 2. Get recipient devices (all linked devices of group members)
  // 3. INSERT INTO mls_relay_recipients for each device
  // 4. Emit socket event to each recipient device
  // 5. Return message
}

async getPendingMessages(deviceId) {
  // SELECT from mls_relay_queue
  // JOIN mls_relay_recipients WHERE recipient_device_id = deviceId AND acked_at IS NULL
  // ORDER BY created_at ASC
}

async ackMessages(deviceId, messageIds) {
  // 1. UPDATE mls_relay_recipients SET acked_at = NOW()
  //    WHERE recipient_device_id = deviceId AND queue_id IN (messageIds)
  // 2. DELETE messages where ALL recipient devices have acked:
  //    DELETE FROM mls_relay_queue WHERE id IN (
  //      SELECT queue_id FROM mls_relay_recipients
  //      GROUP BY queue_id HAVING bool_and(acked_at IS NOT NULL)
  //    )
}

async cleanupExpired() {
  // DELETE FROM mls_relay_queue WHERE expires_at < NOW()
  // Run on startup or via cron
}
```

**Frontend (coreCryptoClient.js):**

```javascript
// Unified sync - call on connect and on socket events
async syncMessages() {
  const pending = await api.mls.getPendingMessages();
  if (pending.length === 0) return [];

  const processed = [];
  for (const msg of pending) {
    try {
      if (msg.message_type === 'welcome') {
        await this.processWelcome(msg);
      } else {
        await this.handleIncomingMessage(msg);
      }
      processed.push(msg.id);
    } catch (e) {
      console.error('[MLS] Failed to process:', msg.id, e);
    }
  }

  if (processed.length > 0) {
    await api.mls.ackMessages(processed);
  }
  return processed;
}

// Simplified socket handlers
setupSocketListeners() {
  registerSocketEventHandler('mls-message', () => this.syncMessages());
  registerSocketEventHandler('mls-welcome', () => this.syncMessages());
}
```

**Message Flow:**

```text
SEND:
  User types message
  → coreCryptoClient.sendMessage()
  → WASM encrypts → POST /api/mls/messages/group
  → storeRelayMessage() inserts into queue + recipients
  → Socket emits 'mls-message' to each recipient device

RECEIVE:
  Socket event 'mls-message' received (or page load)
  → syncMessages() triggered
  → GET /api/mls/queue/pending
  → Process each message (decrypt or process welcome)
  → POST /api/mls/queue/ack with processed IDs
  → Server deletes messages where all recipients acked
```

**Cleanup Policies:**

1. **ACK-based deletion:** Delete message when all recipient devices have ACKed
2. **TTL expiration:** Delete after 30 days if not delivered (configurable)
3. **Device revocation:** Delete pending messages when device is revoked
4. **Startup cleanup:** Run `cleanupExpired()` on server startup

**Security Settings:**

1. Require re-authentication for sensitive actions (add/remove passkeys, device linking, revoke device)
2. Option to require passkey for login (disable password login)

**Files to modify:**

- `backend/migrations/YYYYMMDD_add_relay_queue.sql` (new)
- `backend/src/services/mlsService.js`
- `backend/src/routes/mls.js`
- `frontend/src/services/api.js`
- `frontend/src/services/mls/coreCryptoClient.js`

## User Flows

### New User Registration (First Device)

```text
1. Enter email, password, username
2. Submit → account created, logged in
3. Generate deviceId + local device key + prfInput
4. Wrap device key with password (always)
5. Create initial MLS client identity for this device (device = MLS client)
6. Prompt: "Add a passkey for faster login?" (optional)
   → If yes, register passkey (with PRF if available)
   → If PRF available, also wrap device key with PRF
```

### Existing User Login (Password)

```text
1. Enter email, password
2. Submit → JWT returned
3. Unlock local device keystore with password
4. Device is messaging-capable only if it is linked
   - First device: already linked
   - New device: requires linking approval
```

### Existing User Login (Passkey)

```text
1. Click "Sign in with passkey"
2. Browser prompts for passkey
3. JWT returned (authenticated)
4. If PRF wrapping exists on this device:
   → PRF output unwraps device key
   → Keystore unlocked
5. Otherwise:
   → Prompt for password to unlock keystore
```

### New Device Onboarding (Signal-like)

```text
1. Install/open app on new device
2. Login (passkey or password) → authenticated
3. Device shows "Link this device" QR
4. Existing trusted device scans and approves
5. Trusted device adds this device MLS client to relevant conversations/groups
6. New device receives future messages; no history backfill
```

### Password Change

```text
1. Enter current password, new password
2. Verify current password (backend)
3. Unwrap device key with old password
4. Re-wrap device key with new password
5. Store updated keystore locally
6. PRF-wrapped key (if present) unchanged
```

### Add Passkey

```text
1. User goes to Settings → Security → Passkeys
2. Click "Add passkey"
3. Browser prompts for passkey creation
4. If PRF supported on this device:
   → Wrap device key with PRF output and store locally
5. Credential stored in database
```

## Security Considerations

1. **Device key is random, never derived from password**
   - Password change does not require re-encrypting all device state.
   - Only re-wrap the device key.

2. **PRF input is random per device**
   - Use random `prfInput` stored in the local keystore.
   - Avoid predictable inputs like `vault-key-{userId}`.

3. **Account recovery vs E2EE recovery**
   - Email/password reset can restore account access.
   - It cannot restore prior E2EE state/history if all trusted devices are lost (by design).

4. **Rate limiting**
   - Limit failed password attempts.
   - Limit WebAuthn ceremonies.
   - Consider additional anti-abuse layers for signup.

5. **Storage**
   - WebAuthn credentials stored server-side.
   - MLS state stored locally per device, encrypted at rest.
   - Relay queue stores only ciphertext until delivery/TTL.

## Timeline Estimate

| Phase | Scope | Complexity |
|-------|-------|------------|
| Phase 1 | Password-unlocks keystore | Medium |
| Phase 2 | WebAuthn registration/login | Medium |
| Phase 3 | Device linking | Medium |
| Phase 4 | PRF unlock integration | Medium |
| Phase 5 | Relay queue + edge cases | Medium |

## Dependencies

**Backend:**
- `@simplewebauthn/server` - WebAuthn server-side operations

**Frontend:**
- `@simplewebauthn/browser` - WebAuthn browser API wrapper

## References

- https://messaginglayersecurity.rocks/mls-architecture/ (MLS Architecture)
- https://www.rfc-editor.org/rfc/rfc9420.html (MLS Protocol)
- https://github.com/w3c/webauthn/wiki/Explainer:-PRF-extension (WebAuthn PRF Extension)
- https://simplewebauthn.dev/ (SimpleWebAuthn)
- https://wireapp.github.io/core-crypto/ARCHITECTURE.html (Wire CoreCrypto device model)