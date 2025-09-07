
# Phase 1 E2EE Hardening Implementation Plan (with Code Snippets)

## 1. Backend: Socket.IO JWT Authentication

**Add JWT middleware in `backend/src/index.js` (using existing `backend/src/utils/jwt.js`):**
```js
const { verifyToken } = require('./utils/jwt');

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));
  const payload = verifyToken(token);
  if (payload?.error) return next(new Error('Invalid token'));
  socket.userId = payload.userId;
  next();
});
```

## 2. Backend: Secure Room Join Handlers

**Refactor room joins to use `socket.userId`:**
```js
socket.on('join-messaging', () => {
  if (socket.userId) {
    socket.join(`messaging:${socket.userId}`);
    console.log(`User ${socket.userId} joined messaging room`);
  }
});

socket.on('join-conversation', async (conversationId) => {
  // Check DB that socket.userId is a participant
  const isParticipant = await checkConversationMembership(conversationId, socket.userId);
  if (isParticipant) {
    socket.join(`conversation:${conversationId}`);
    console.log(`User ${socket.userId} joined conversation room ${conversationId}`);
  }
});
```
*Implement `checkConversationMembership` in messagingService.*

## 3. Backend: CORS Restriction

**Restrict CORS:**
```js
const allowedOrigins = [process.env.FRONTEND_URL];
io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});
```
Also remove the current permissive setting in `backend/src/index.js` where `origin: "*"` is used.

## 4. Frontend: Socket Connection with JWT

**Send JWT on connect in `frontend/src/services/socket.js` (using existing `frontend/src/services/auth.js`):**
```js
import { getToken } from './auth.js';
const token = getToken();
socket = io(socketUrl, {
  auth: { token },
  transports: ['websocket'],
  // ...existing config...
});
```
Also avoid passing `userId` from the client for room joins:
```js
socket.on('connect', () => {
  socket.emit('join-messaging'); // server derives user from JWT
});
```

## 5. Frontend: Key Encryption at Rest

**Encrypt private key before storing in IndexedDB:**
```js
import { deriveKey, encryptData, decryptData } from './crypto.js';

// On key generation/import:
const passphrase = await promptUserForPassphrase();
const salt = window.crypto.getRandomValues(new Uint8Array(16));
const aesKey = await deriveKey(passphrase, salt);
const encryptedPrivateKey = await encryptData(aesKey, privateKeyBase64);

// Store { encryptedPrivateKey, salt } in IndexedDB
```
*Add unlock flow on app start: prompt for passphrase, derive key, decrypt.*

Add a basic lock method to drop the in-memory private key reference:
```js
// keyManager.lockKeys()
this.privateKey = null;
```

## 6. Frontend: Lock/Unlock and Backup Flow

**Lock after idle/logout:**
```js
// On logout or after inactivity:
keyManager.lockKeys();
```
**Backup/export:**
```js
// Export encryptedPrivateKey and salt for backup
```

## 7. Frontend: TOFU Pinning for Public Keys

**Store and verify fingerprints:**
```js
// On first fetch:
localStorage.setItem(`fingerprint:${userId}`, fingerprint);

// On subsequent fetch:
const stored = localStorage.getItem(`fingerprint:${userId}`);
if (stored && stored !== fingerprint) {
  showWarning('Public key for user changed! Possible attack.');
  blockMessaging();
}
```
**Display own fingerprint in settings:**
```js
const myFingerprint = await keyManager.getKeyFingerprint(myPublicKeyBase64);
showFingerprintToUser(myFingerprint);
```

## 8. Minimal Tests

**Backend:**
- Test unauthenticated socket connection is rejected.
- Test only authorized user can join their messaging/conversation room.
- Test that clients cannot join rooms for other users or conversations they do not belong to.

**Frontend:**
- Test key encryption/decryption with correct/wrong passphrase.
- Test fingerprint pinning blocks on key change.

---


---

# Phase 2: Cryptographic Hardening and Anti-Replay

## 1. Bind Metadata with AEAD AAD
**In `frontend/src/services/crypto.js`:**
```js
// When encrypting:
const additionalData = JSON.stringify({
  version: 1,
  conversationId,
  senderId,
  receiverId,
  messageType,
  timestamp,
  messageId
});
const encrypted = await window.crypto.subtle.encrypt({
  name: 'AES-GCM',
  iv,
  additionalData: new TextEncoder().encode(additionalData)
}, sessionKey, data);
```
// When decrypting, supply the same additionalData.

## 2. Introduce messageId (UUID v4) client-side
**In `frontend/src/services/messaging.js` and DB migration:**
```js
import { v4 as uuidv4 } from 'uuid';
const messageId = uuidv4();
// Add messageId to each message sent and stored.
```
**DB migration:**
```sql
ALTER TABLE messages ADD COLUMN message_id UUID;
CREATE UNIQUE INDEX messages_conversation_id_message_id_idx ON messages(conversation_id, message_id);
```

## 3. Remove plaintext contentHash from server
**In `backend/src/services/messagingService.js`:**
- Remove or replace content_hash with a hash of ciphertext if needed.
- If keeping for legacy, verify on client post-decrypt and plan removal.

## 4. Sanitize logs
**In frontend and backend:**
- Remove console logging of decrypted messages and sensitive fields.
Also remove token logging in `backend/src/middleware/auth.js`:
```diff
  const token = authHeader.split(" ")[1];
-  console.log('Token:', token);
  // Do not log tokens
```

---

# Phase 3: Forward Secrecy and Key Lifecycle

## 1. Migrate to X25519 ECDH (libsodium sealed boxes)
**In `frontend/src/services/crypto.js`:**
```js
// Use X25519 for key exchange, derive shared secret with HKDF, use for AES-GCM.
// Use libsodium.js or tweetnacl.js for X25519 operations.
```
**Backend:**
- Store public X25519 keys for users.

## 2. Double Ratchet (optional, advanced)
**Integrate a double-ratchet library for per-message forward secrecy.**

## 3. Key Versioning and History
**In `frontend/src/services/keyManager.js` and DB:**
- Tag each message’s session key with the recipient key version used.
- Keep older private keys encrypted in IndexedDB to decrypt history.
- Allow optional secure cleanup of old keys.

## 4. Key Revocation and Rotation
**In frontend and backend:**
- Support revoking keys and preventing future encryption to revoked keys.
- Notify users of key changes and require re-verification.

---

This plan now includes actionable code snippets and implementation details for all phases of E2EE hardening. Expand any section for more detail or implementation guidance as needed.

---

# Additional Phase 1 Hardening Based on Review

## 9. Backend: Validate receiver belongs to conversation
Ensure `receiverId` matches the other participant of `conversationId` when sending messages.
```js
// backend/src/services/messagingService.js (inside sendMessage before insert)
const convo = await db.query(
  `SELECT participant_1, participant_2 FROM conversations WHERE id = $1`,
  [conversationId]
);
if (convo.rowCount === 0) throw new Error('Conversation not found');
const { participant_1, participant_2 } = convo.rows[0];
if (senderId !== participant_1 && senderId !== participant_2) {
  throw new Error('Sender is not part of this conversation');
}
const expectedReceiver = senderId === participant_1 ? participant_2 : participant_1;
if (receiverId !== expectedReceiver) {
  throw new Error('Receiver does not match conversation participants');
}
```

## 10. Backend: Emit minimal socket payloads
Avoid broadcasting full message records (including both session keys). Use IDs-only and let clients fetch via the authenticated HTTP API.

Example:
```js
io.to(`messaging:${receiverId}`).emit('newMessage', { messageId: message.id, conversationId });
io.to(`messaging:${senderId}`).emit('messageSent', { messageId: message.id, conversationId });
// Client then calls GET /messages/conversations/:conversationId/messages to fetch
```

Frontend handling:
```js
socket.on('newMessage', async ({ conversationId }) => {
  if (selectedConversationId === conversationId) {
    const { messages } = await api.messages.getMessages(conversationId, 50, 0);
    const decrypted = await decryptMessages(messages);
    setMessages(conversationId, decrypted);
  } else {
    incrementUnread(conversationId, 1);
  }
});
```

## 11. Backend: Message size limits and abuse controls
- Enforce a maximum size for `encrypted_content` (e.g., 16 KB):
```js
if (Buffer.byteLength(encryptedContent, 'base64') > 16 * 1024) {
  return res.status(400).json({ error: 'Message too large' });
}
```
- Add rate limiting to `sendMessage`, `createConversation`, and search endpoints using `express-rate-limit`.
```js
const rateLimit = require('express-rate-limit');
const sendMessageLimiter = rateLimit({ windowMs: 60_000, max: 120 });
router.post('/messages/conversations/:conversationId/messages', authenticateJWT, sendMessageLimiter, messagingController.sendMessage);
```

## 12. Frontend: Use auth service and remove userId from joins
Update `frontend/src/services/socket.js` to:
- Use `getToken()` for `auth` in `io()` options.
- Emit `join-messaging` without parameters.
- Keep conversation joins as `join-conversation` with just the `conversationId`.

```js
import { getToken } from './auth';
const token = getToken();
socket = io(socketUrl, { auth: { token }, transports: ['websocket'] });
socket.on('connect', () => {
  socket.emit('join-messaging');
});
```

## 13. Logging hygiene
- Remove token logging in `backend/src/middleware/auth.js`.
- Avoid logging decrypted content in frontend services.

## 14. Tests additions
- Verify that clients cannot join rooms for other users or conversations they do not belong to.
- Verify large messages are rejected and rate limits trigger.

---

# Additional Next Steps

## A. Frontend: Keep socket auth fresh and clean up on logout
Ensure the Socket.IO client always presents the latest JWT and cleans up connections.
```js
// frontend/src/services/socket.js
import { getToken } from './auth';

// Before (re)connect attempts, refresh auth payload
if (socket) {
  socket.auth = { token: getToken() };
}

// Also on reconnect attempt
socket.io.on('reconnect_attempt', () => {
  socket.auth = { token: getToken() };
});

// On logout, disconnect socket to drop room membership
export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
  }
}
```

## B. Security headers and XSS hardening (protect key at rest)
Mitigate key exfiltration risk and tighten browser security.
```js
// backend/app hardening (Express)
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // reduce/remove inline/eval if possible
    "connect-src 'self' " + (process.env.FRONTEND_URL || 'http://localhost:3000'),
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
```
Consider migrating JWT from `localStorage` to HttpOnly, Secure, SameSite=Lax cookies (if API domain allows) to further reduce XSS blast radius. If using cookies, add CSRF protection (SameSite or CSRF token).

## C. Attachments security (message_type: image/file)
When enabling files/images, never accept raw base64 in messages. Use object storage + pre-signed URLs:
- Validate MIME type and size server-side; set max (e.g., 5–10 MB) per file.
- Virus scan uploads (e.g., ClamAV) before generating pre-signed GET URLs.
- Store only metadata and encrypted references in `messages` (do not inline blobs).
- Strip EXIF for images server-side if needed for privacy.

High-level flow:
1) Client requests pre-signed PUT URL for upload; backend enforces content-type/size.
2) Client uploads directly to object store.
3) Client sends normal E2EE message with an encrypted descriptor (URL + key/nonce) as `encrypted_content`.
4) Recipient decrypts descriptor and downloads via pre-signed GET.

## D. Database guards
- Add DB-level length constraint for `encrypted_content` to cap payload size (based on expected base64 size).
```sql
ALTER TABLE messages
  ADD CONSTRAINT encrypted_content_max_len
  CHECK (char_length(encrypted_content) <= 24576); -- ~18KB base64 ≈ 13.5KB raw
```
- Ensure partial indexes remain aligned with queries; periodically ANALYZE for performance.

## E. Replay protection details
With Phase 2 `messageId`:
- Enforce uniqueness with the composite unique index (already planned) and return 409 on duplicate.
- Optionally store a short-lived Bloom filter/redis set of recent IDs to fast-reject without hitting DB.
- Include `messageId`, `senderId`, `receiverId`, `conversationId`, and `timestamp` in AES-GCM AAD as planned.

## F. Sender authenticity (optional but recommended)
Add per-user signing keys (Ed25519) to authenticate the sender end-to-end.
- Store public signing key alongside RSA/X25519 public key.
- Sender signs over: `messageId | ciphertext | AAD`.
- Receiver verifies signature before accepting message.
- Server stores signature (opaque) but does not need to verify.

## G. Observability and abuse monitoring
- Emit metrics for socket auth failures, room join denials, rate-limit hits, and large-message rejects.
- Add alerts on spikes to detect scraping/abuse.

## H. Device keys and multi-device support
- Allow multiple public keys per user (one per device) and encrypt session keys for each active device.
- Track device key IDs; include intended recipients in AAD.

## I. Expanded tests (API + socket + crypto)
## J. Docker dev workflow (nodemon)
- Use nodemon in the backend container for hot reloads.
- Mount `backend/src` into the container (already configured) and run `npm run dev` in `backend/docker-compose.yml`.
- Ensure `nodemon` is installed (present in devDependencies) and `package.json` uses `nodemon --watch src --legacy-watch` for Docker filesystems.

## K. Environment configuration
- Set `FRONTEND_URL` in backend env for CORS/CSP.
- Ensure DATABASE_URL points at the `db` service (e.g., `postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB`).
- Expose ports: backend `3000`, frontend `5173`, prediction engine `3001` through Caddy or compose as needed.
- Socket: invalid/expired JWT rejected at handshake; cannot join other users’ rooms; cannot join conversations without membership.
- HTTP: `sendMessage` rejects mismatched `receiverId`; size limits enforced; rate limits enforced.
- Crypto: decryption fails on altered AAD; duplicate `messageId` rejected; signature verification required (if enabling signatures).

## L. Security Best Practices Alignment (SOTA targets)

- Per-device keys (multi-device):
  - Maintain multiple active public keys per user (one per device). Encrypt each outbound message’s session key to all active device keys.
  - Track device key IDs and include intended recipients in AAD.
  - Provide UI to list/revoke device keys. Revocation prevents future encryption to that device.

- Key change transparency and verification:
  - Display safety numbers/fingerprints and prompt re-verification on key changes (TOFU pinning already planned in Phase 1).
  - Notify contacts when a user’s key set changes. Block messaging on mismatch until acknowledged.

- Backups and restores (user-controlled):
  - Optional encrypted backup of private keys (passphrase-derived key, never plaintext; never server-readable without passphrase).
  - Explicit restore flow; never silently re-generate on behalf of user.

- Session protocol hardening:
  - Roadmap: adopt X3DH + Double Ratchet (Signal-style) for forward secrecy and post-compromise security.
  - Interim: AEAD with AAD binding, message IDs, replay protection (Phase 2), sender authenticity via Ed25519 (optional in Phase 2/3).

- Logging hygiene and CSP:
  - Remove sensitive logs (tokens, decrypted content). Keep CSP tightened; prefer eliminating inline/eval scripts.

- Temporary extractable export/wrap pattern (Web Crypto best practice)
  - Purpose: allow a secure, portable encrypted-at-rest copy while minimizing exposure in memory.
  - Pattern:
    1) Import/create private key as extractable=true only for a one-time export/wrap
    2) Export (or wrap) key bytes; immediately encrypt with PBKDF2(AES-GCM) or WebAuthn-derived key
    3) Persist only the encrypted blob in IndexedDB with version + KDF params
    4) Re-import a working key instance as extractable=false (steady state) and discard the extractable instance
    5) Zeroise all temporary ArrayBuffers
  - Hardening:
    - Perform export/wrap in a dedicated Worker (or same-origin sandboxed iframe); terminate it after
    - Strong CSP + Trusted Types to reduce XSS risk
    - Ensure AES session keys are generated as extractable=false
    - Add a unit test/guard to assert `privateKey.extractable === false` after initialization

- Policy: no silent key overwrite
  - If server has a public key but local private key is missing, do not auto-generate and upload a new key.
  - Surface a “Needs Repair” state to the user and offer an explicit Repair Keys action.

- Action items
  - Add Settings → Security page:
    - Show device keys/fingerprints; add/revoke device keys; “Repair Keys” button; export encrypted backup.
  - Implement multi-device key storage on backend (schema for device keys with metadata and status).
  - Update send path to encrypt to all recipient device keys; tag messages with key-id set.
  - Add contact re-verification UX on key changes.
  - Add tests: device scoping, revocation, multiple-recipient encryption, backup/restore.

## M. TODOs (trackable tasks)

- Phase 1 – Socket and baseline hardening
  - [x] Backend: Ensure Socket.IO JWT middleware is active in [backend/src/index.js](backend/src/index.js) and rejects invalid/absent tokens.
  - [x] Backend: Validate conversation membership on `join-conversation` in [backend/src/index.js](backend/src/index.js) using [backend/src/services/messagingService.js](backend/src/services/messagingService.js).
  - [x] Backend: Restrict Socket.IO CORS to `FRONTEND_URL` in [backend/src/index.js](backend/src/index.js). CSP headers present.
  - [x] Backend: Enforce message size limit (e.g., 16KB base64) in [backend/src/controllers/messagingController.js](backend/src/controllers/messagingController.js) or service.
  - [x] Backend: Add rate limiting to send/create/search endpoints in [backend/src/routes/api.js](backend/src/routes/api.js).
  - [x] Frontend: Use JWT auth for socket connect and refresh `socket.auth` on reconnect in [frontend/src/services/socket.js](frontend/src/services/socket.js).
  - [x] Frontend: Remove userId from client-side room joins; only use `join-messaging` and `join-conversation` with validated server auth in [frontend/src/services/socket.js](frontend/src/services/socket.js).
  - [x] Frontend: Stop logging decrypted content and other sensitive data across services.

- Phase 1 – Keys at rest and UX
  - [x] Frontend: Encrypt private key before storing in IndexedDB (passphrase-derived key) in [frontend/src/services/keyManager.js](frontend/src/services/keyManager.js) and [frontend/src/services/crypto.js](frontend/src/services/crypto.js). Add `unlock(passphrase)` and `lockKeys()` APIs.
  - [x] Frontend: Add basic Lock/Unlock controls in Settings and auto-lock on logout.
  - [x] Frontend: Add idle auto-lock (default 15 min) with user-configurable timeout in Settings.
  - [ ] Frontend: Implement TOFU key pinning and mismatch warning; display own fingerprint in Settings.
  - [ ] Frontend: Add Settings → Security page (device keys list, fingerprints, Repair Keys, export encrypted backup).
  - [x] Frontend: Do not silently overwrite server key if local private key missing (implemented in keyManager.ensureKeys); surface "Needs Repair" state; [ ] Add UI to repair.
  - [ ] Frontend: Switch to temporary-extractable flow for encrypt-at-rest and backups (one-time export/wrap, then re-import as non-extractable; discard extractable instance; zeroise buffers)
  - [ ] Frontend: Ensure AES session keys are generated with extractable=false
  - [ ] Frontend: Add a small unit test/guard that asserts `privateKey.extractable === false` in steady state
  - [ ] Frontend: Move export/wrap to a dedicated Worker and terminate it after use

- Phase 1 – WebAuthn (Signal-like unlock without passphrase typing)
  - [ ] Backend: Add WebAuthn registration/auth endpoints using `@simplewebauthn/server`:
    - POST `/webauthn/register/start` → challenge
    - POST `/webauthn/register/finish` → verify, store credential (credentialID, publicKey, counter, transports)
    - POST `/webauthn/auth/start` → challenge
    - POST `/webauthn/auth/finish` → verify assertion
  - [ ] DB: Create `device_credentials` table: user_id, credential_id (base64url), public_key (PEM/DER), sign_count, transports, created_at, last_used_at, device_label
  - [ ] Frontend: Integrate `@simplewebauthn/browser` to perform create/get; bind successful auth to unwrap private key
  - [ ] Frontend: Wrap/unwrap private key using a non-extractable AES key derived from WebAuthn (wrapKey/unwrapKey) and store only wrapped key in IndexedDB
  - [ ] UI: Settings → Security: “Use biometrics to unlock” toggle; Register device; “Unlock with biometrics” button; fallback to passphrase

- Phase 2 – Crypto hardening
  - [ ] Frontend/DB: Introduce `messageId` (UUID v4), migration and unique composite index.
  - [ ] Frontend: Bind metadata in AEAD AAD (version, conversationId, senderId, receiverId, messageType, timestamp, messageId).
  - [ ] Backend: Remove plaintext `content_hash` (or switch to ciphertext hash) in [backend/src/services/messagingService.js](backend/src/services/messagingService.js).
  - [ ] Tests: Replay protection, duplicate `messageId` rejection (409), AAD tamper detection.

- Phase 3 – Forward secrecy and multi-device
  - [ ] Frontend/Backend: Add X25519 public keys and migrate session key exchange to X25519 + HKDF (libsodium.js / tweetnacl.js).
  - [ ] Optional: Integrate Double Ratchet for per-message forward secrecy.
  - [ ] Backend: Multi-device key schema (device keys table with status, created_at, last_used_at).
  - [ ] Frontend/Backend: Encrypt session keys to all active device keys; include device key IDs in AAD; support revocation.
  - [ ] UX: Contact re-verification prompts on key changes.
  - [ ] Tests: Device scoping, revocation, multiple-recipient encryption, backup/restore E2E.

- Logging and observability
  - [x] Backend: Remove token logs and sensitive payloads from middleware and controllers (no token logging present; CSP headers added).
  - [ ] Metrics: Add counters for socket auth failures, join denials, rate-limit hits, large-message rejects; set alerts.

- Attachments (if/when enabled)
  - [ ] Backend: Presigned upload/download endpoints with size/type validation and scanning; never store raw base64 in messages.
  - [ ] Frontend: Use encrypted descriptors instead of inline blobs.
  - [ ] Tests: Size/type limits, scanning path, descriptor decrypt path.

