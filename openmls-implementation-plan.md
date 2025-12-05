# SOTA E2EE Implementation Plan (OpenMLS)

This plan consolidates the E2EE hardening phases with the OpenMLS migration. MLS (RFC 9420) replaces the planned Signal Protocol approach and provides PFS/PCS natively.

---

## Is This SOTA E2EE?

**Yes.** OpenMLS implements RFC 9420 (Messaging Layer Security), designed to match or exceed Signal's security properties while scaling better for groups.

### SOTA Criteria Comparison

| Criterion | Signal | OpenMLS/MLS | Status |
|-----------|--------|-------------|--------|
| **Perfect Forward Secrecy (PFS)** | Double Ratchet | Ratchet Tree | Built-in |
| **Post-Compromise Security (PCS)** | Session reset | Update/Commit mechanism | Built-in |
| **Authentication** | Safety Numbers (fingerprints) | Credential validation + fingerprints | Needs UI |
| **Encryption at Rest** | Secure Enclave / passphrase | Argon2id + AES-GCM | Needs implementation |
| **Group Scalability** | O(n) per message | O(log n) per message | Built-in |
| **Formal Verification** | Partial | Protocol formally verified | Built-in |

### What OpenMLS Provides Natively

From the OpenMLS Book:

- **Ciphersuites**: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (MTI), ChaCha20-Poly1305, P-256
- **WASM Support**: Builds for `wasm32-unknown-unknown` with `js` feature for browser APIs
- **Forward Secrecy**: Keys deleted immediately after use; configurable `max_past_epochs` for late messages
- **Message Validation**: Comprehensive semantic validation (ValSem002-ValSem403)
- **Fork Resolution**: Built-in `readd` and `reboot` helpers for group recovery

### What We Must Implement for SOTA

1. **Credential Validation** - Application must validate credentials on join and message processing
2. **Encryption at Rest** - Protect IndexedDB with passphrase-derived key
3. **Safety Numbers UI** - Display fingerprints for manual verification
4. **TOFU Pinning** - Warn on credential/key changes
5. **Proper Key Deletion** - Ensure StorageProvider deletes securely (no copies)

---

## Architecture Overview

**Four Pillars of SOTA E2EE:**
1. **Perfect Forward Secrecy (PFS)**: Via OpenMLS Ratchet Tree
2. **Post-Compromise Security (PCS)**: Via OpenMLS Update/Commit mechanism
3. **Authentication (Trust Layer)**: Safety Numbers + Credential Validation
4. **Endpoint Security (Storage Layer)**: Encryption at Rest using Argon2id-derived keys

**Components:**
- **Frontend (WASM)**: `openmls-wasm` crate - all crypto ops, Argon2id key derivation
- **Frontend (JS)**: `CoreCryptoClient` - WASM lifecycle, encrypted IndexedDB, API communication
- **Backend**: Delivery Service (DS) + Authentication Service (AS) - stores Key Packages, forwards encrypted messages
- **Database**: MLS tables for key packages, welcome messages, group messages

**Key OpenMLS Concepts (from the Book):**
- **KeyPackage**: Public identity + HPKE encryption key for async group joins
- **Credential**: Identity binding (we use `BasicCredential` with username)
- **MlsGroup**: The group state machine
- **Welcome**: Message to invite new members
- **Commit**: Message that applies proposals and advances epoch
- **Proposal**: Add, Remove, Update, etc. - can be inline or by-reference

---

## Progress Tracking

### Phase 1A: OpenMLS Core (WASM/Rust)

- [x] Basic `MlsClient` struct with provider and storage
- [x] `create_identity(username)` - credential + signature keypair + key package
- [x] `get_key_package_bytes()` - serialize public KeyPackage for upload
- [x] `create_group(group_id)` - create new MLS group
- [x] `add_member(group_id, key_package)` - add member, returns (welcome, commit)
- [x] `process_welcome(welcome_bytes)` - join group from welcome message
- [x] `process_commit(group_id, commit_bytes)` - process incoming commits
- [x] `encrypt_message(group_id, message)` - encrypt application message
- [x] `decrypt_message(group_id, ciphertext)` - decrypt application message
- [x] `derive_key_argon2id(password, salt)` - Argon2id key derivation for storage encryption
- [x] `get_identity_fingerprint()` - SHA-256 fingerprint for Safety Numbers
- [x] State serialization (`get_credential_bytes`, `get_signature_keypair_bytes`, `get_key_package_bundle_bytes`)
- [x] State restoration (`restore_identity`)
- [ ] `export_group_state(group_id)` - serialize group for persistence
- [ ] `import_group_state(state_bytes)` - restore group from persistence
- [ ] `self_update(group_id)` - key rotation for PCS (see Book: "Updating own leaf node")
- [ ] `remove_member(group_id, leaf_index)` - remove member from group
- [ ] `leave_group(group_id)` - create remove proposal for self
- [ ] `get_group_members(group_id)` - list members with credentials
- [ ] `propose_add/remove/update()` - create standalone proposals

### Phase 1B: Database Schema

- [x] `mls_key_packages` table (user_id, device_id, package_data, hash)
- [x] `mls_welcome_messages` table (group_id, receiver_id, data)
- [x] `mls_group_messages` table (group_id, sender_id, epoch, content_type, data)
- [x] Indexes on user_id, receiver_id, group_id+epoch
- [ ] `mls_groups` table (group_id, name, created_by, created_at) - group metadata
- [ ] `mls_group_members` table (group_id, user_id, joined_at) - membership tracking
- [ ] Key package validity/expiration tracking (see Book: "Example: Key packages")

### Phase 1C: Backend API Routes

- [x] `POST /api/mls/key-package` - upload key package
- [x] `GET /api/mls/key-package/:userId` - fetch user's key package
- [x] `POST /api/mls/messages/welcome` - send welcome message
- [x] `GET /api/mls/messages/welcome` - fetch pending welcome messages
- [x] `DELETE /api/mls/messages/welcome/:id` - delete processed welcome
- [x] `POST /api/mls/messages/group` - send commit/application message
- [x] `GET /api/mls/messages/group/:groupId` - fetch group messages
- [ ] Strict message ordering with DB locking in `storeGroupMessage`
- [ ] Socket.io `mls-message` event for real-time group message delivery
- [ ] Socket.io `mls-welcome` event for real-time welcome delivery
- [ ] Key package validation endpoint (check expiration, ciphersuite compatibility)

### Phase 1D: Frontend Integration (CoreCryptoClient)

- [x] WASM module initialization (`init()`, `init_logging()`)
- [x] IndexedDB setup for state persistence
- [x] `ensureMlsBootstrap(username)` - create or restore identity
- [x] `saveState()` / `loadState()` - persist/restore from IndexedDB
- [x] `getKeyPackageBytes()` / `getKeyPackageHex()` - export public key package
- [ ] Upload key package to server on login/identity creation
- [ ] `createGroup(groupId)` - wrapper for WASM create_group
- [ ] `inviteToGroup(groupId, userId)` - fetch key package + add_member + send welcome
- [ ] `joinGroup(welcomeBytes)` - process welcome message
- [ ] `sendMessage(groupId, plaintext)` - encrypt + POST to server
- [ ] `handleIncomingMessage(groupId, ciphertext)` - decrypt incoming
- [ ] Socket event handlers for `mls-message` and `mls-welcome`
- [ ] Group state persistence (export/import on page load/unload)
- [ ] Handle `StagedCommit` inspection before merge (credential validation)

### Phase 1E: Encrypted Storage ("The Vault")

From the Book: "StorageProvider implementations must ensure values deleted through delete_ functions are irrevocably deleted and no copies are kept."

- [x] Argon2id key derivation in WASM
- [ ] Prompt for encryption passphrase on first login
- [ ] Derive AES-GCM key from passphrase using WASM `derive_key_argon2id`
- [ ] Encrypt IndexedDB state with derived key before storing
- [ ] Decrypt on unlock with correct passphrase
- [ ] `lockKeys()` - wipe in-memory keys (zeroise buffers)
- [ ] Auto-lock after idle timeout (configurable, default 15 min)
- [ ] "Panic Button" - wipe all local crypto state
- [ ] Ensure key deletion is permanent (no IndexedDB snapshots/copies)

### Phase 1F: Trust Layer (Safety Numbers / Credential Validation)

From the Book: "The application maintains reference identifiers for members. A member is authenticated by validating credentials and ensuring reference identifiers match presented identifiers."

- [x] `get_identity_fingerprint()` in WASM
- [ ] `getFingerprint()` method in CoreCryptoClient
- [ ] Credential validation on group join (inspect `StagedWelcome.members()`)
- [ ] Credential validation on commit processing (inspect `StagedCommit` add/update proposals)
- [ ] "Verify Session" modal in UI showing fingerprint
- [ ] Store `is_verified` status for contacts in IndexedDB
- [ ] TOFU pinning: warn on fingerprint/credential change
- [ ] Display own fingerprint in Settings
- [ ] Block messaging on credential mismatch until acknowledged

---

### Phase 2: Socket & Transport Hardening

- [x] Backend: Socket.IO JWT middleware (reject invalid/absent tokens)
- [x] Backend: Validate conversation membership on `join-conversation`
- [x] Backend: Restrict Socket.IO CORS to `FRONTEND_URL`
- [x] Backend: CSP headers present
- [x] Backend: Message size limit (16KB base64)
- [x] Backend: Rate limiting on send/create/search endpoints
- [x] Frontend: JWT auth for socket connect
- [x] Frontend: Refresh `socket.auth` on reconnect
- [x] Frontend: Remove userId from client-side room joins
- [x] Frontend: Stop logging decrypted content
- [x] Backend: Remove token logging from middleware
- [ ] Metrics: Counters for socket auth failures, join denials, rate-limit hits

---

### Phase 3: Crypto Hardening (Message Integrity)

From the Book: "AAD is always authenticated but never encrypted. Structure of AAD is application-defined."

- [ ] Use MLS AAD field for binding metadata (groupId, epoch, timestamp)
- [ ] Frontend/DB: Introduce `messageId` (UUID v4) with unique composite index
- [ ] Backend: Reject duplicate `messageId` (409 Conflict)
- [ ] Tests: AAD tamper detection, replay protection

---

### Phase 4: Multi-Device Support

From the Book: "Clients can generate an arbitrary number of key packages ahead of time... keep private key material locally in key store."

- [ ] Backend: Device keys table (user_id, device_id, key_package, status, created_at, last_used_at)
- [ ] Backend: Store multiple key packages per user (one per device)
- [ ] Frontend: Device registration flow (generate new KeyPackage per device)
- [ ] Frontend: When adding to group, add all active device KeyPackages
- [ ] UI: Settings → Devices: list/revoke device keys
- [ ] Contact re-verification prompts on key changes
- [ ] "Last resort" KeyPackage support for always-available invite

---

### Phase 5: Chat UI

- [ ] Conversations list component
- [ ] Chat view component (message bubbles, input)
- [ ] Create group / start DM flow
- [ ] Invite user to group flow
- [ ] Real-time message updates via socket
- [ ] Message status indicators (sent, delivered, read)
- [ ] Typing indicators
- [ ] Unread counts
- [ ] Member list with verification status badges

---

### Phase 6: Advanced Features (Future)

- [ ] Passwordless auth using MLS signature keys (challenge/response)
- [ ] File/image attachments (presigned URLs, encrypted descriptors)
- [ ] Message reactions
- [ ] Message editing/deletion
- [ ] Group admin controls (promote, demote, remove)
- [ ] Read receipts with E2EE
- [ ] Disappearing messages
- [ ] Fork detection and resolution (using OpenMLS helpers)
- [ ] External commits for joining public groups
- [ ] Custom proposals for app-specific group features

---

### Phase 7: Robustness & Edge Cases

From the Book: "Fork Resolution", "Discarding Commits", "Forward Secrecy Considerations"

- [ ] Handle delivery service message reordering (`out_of_order_tolerance` config)
- [ ] Handle late messages from past epochs (`max_past_epochs` config)
- [ ] Handle dropped messages (`maximum_forward_distance` config)
- [ ] Fork detection (compare `confirmation_tag` across members)
- [ ] Fork resolution via `readd` or `reboot` helpers
- [ ] Commit rejection handling (`clear_pending_commit()`)
- [ ] Graceful degradation when WASM fails to load

---

## Key Implementation Notes (from OpenMLS Book)

### Credential Validation (CRITICAL for SOTA)
```
Applications MUST define a maximum total lifetime acceptable for a LeafNode.
The application maintains "reference identifiers" for members.
When credentials are replaced, AS MUST verify the new credential is a valid successor.
```

### Forward Secrecy Requirements
```
StorageProvider implementations must ensure deleted values are irrevocably deleted.
Keys are discarded immediately after encryption (author can't decrypt own messages).
Configure max_past_epochs, out_of_order_tolerance, maximum_forward_distance for delivery tolerance.
```

### AAD (Additional Authenticated Data)
```
AAD is always authenticated but never encrypted.
Structure is application-defined.
Must fit within AEAD limits.
```

### WebAssembly Notes
```
Requires js feature for browser APIs (randomness, time).
Uses web_sys crate for JavaScript interop.
```

---

## File Reference

| Component | File |
|-----------|------|
| WASM Crate | `openmls-wasm/src/lib.rs` |
| WASM Build | `openmls-wasm/Cargo.toml` |
| Frontend Client | `frontend/src/services/mls/coreCryptoClient.js` |
| Backend Routes | `backend/src/routes/mls.js` |
| Backend Service | `backend/src/services/mlsService.js` |
| DB Migration | `migrations/20251120_add_mls_tables.sql` |
| OpenMLS Reference | `openmls-wasm/OpenMLS Book.txt` |

---

## Quick Commands

```bash
# Build WASM (from openmls-wasm/)
wasm-pack build --target web

# Copy to frontend
cp -r pkg/* ../frontend/openmls-pkg/

# Start full stack
docker compose up -d

# Check health
curl http://localhost:3000/api/health-check
```

---

## Summary: Path to SOTA

| Requirement | Current State | Action Needed |
|-------------|---------------|---------------|
| PFS | OpenMLS ratchet tree | None (built-in) |
| PCS | OpenMLS Update/Commit | Implement `self_update()` |
| Authentication | Fingerprint in WASM | Add UI + credential validation |
| Encryption at Rest | Argon2 in WASM | Implement "Vault" flow |
| Secure Deletion | IndexedDB | Verify no copies/snapshots |
| Group Messaging | Core ops done | Wire up UI + sockets |

**Estimated completion to MVP E2EE messaging:** Phases 1D, 1E, 1F, and Phase 5 (Chat UI)
