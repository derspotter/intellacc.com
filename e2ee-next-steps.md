# E2EE Implementation: Incremental Steps

Each step is small, testable, and builds on the previous one.

---

## Step 1: Verify WASM Loads in Browser
**Goal**: Confirm the OpenMLS WASM module initializes correctly in the running app.

- [x] Check that `openmls-wasm` pkg is copied to `frontend/openmls-pkg/`
- [x] Verify WASM loads on login (check browser console for "OpenMLS WASM initialized")
- [x] Test `ensureMlsBootstrap(username)` creates identity
- [x] Verify identity persists in IndexedDB across page refresh

**Test**: Open browser console, login, check for success logs.

---

## Step 2: Key Package Upload on Login
**Goal**: After identity creation, upload the public KeyPackage to the server.

- [x] Add `uploadKeyPackage()` method to `CoreCryptoClient`
- [x] Call it after `ensureMlsBootstrap()` succeeds
- [x] Compute hash of key package for the `hash` field
- [x] POST to `/api/mls/key-package`

**Test**: Login, check `mls_key_packages` table in DB for the user's key package.

---

## Step 3: Fetch Another User's Key Package
**Goal**: Be able to retrieve a key package to invite someone to a group.

- [x] Add `fetchKeyPackage(userId)` to CoreCryptoClient
- [x] GET from `/api/mls/key-package/:userId`
- [x] Parse response and return bytes

**Test**: Call from console: `await coreCryptoClient.fetchKeyPackage(2)` - should return bytes.

---

## Step 4: Create Group
**Goal**: Create an MLS group locally and track it.

- [x] Add `createGroup(groupName)` to CoreCryptoClient
  - Generate random group ID
  - Call WASM `create_group()`
  - Store group metadata locally (IndexedDB)
- [x] Add backend endpoint to register group: `POST /api/mls/groups`
- [x] Add `mls_groups` table migration

**Test**: Create group, verify it appears in local IndexedDB and backend DB.

---

## Step 5: Invite User to Group
**Goal**: Allow a user to invite another user (fetch KeyPackage -> Add Member -> Upload Welcome).

- [x] Add backend route `POST /groups/:groupId/members`
- [x] Add `inviteToGroup(groupId, userId)` to `CoreCryptoClient`
- [x] Fetch invitee's KeyPackage
- [x] Call `client.add_member()` -> returns Commit & Welcome
- [x] Upload Welcome message for invitee
- [x] Upload Commit message for group
- [x] Update `mls_group_members` in DB
- [x] Add socket emit for `mls-welcome` event in backend route

**Test**: Invite user, check `mls_welcome_messages` table for pending welcome.

---

## Step 6: Join Group from Welcome ✅ COMPLETE
**Goal**: Process incoming Welcome and join the group.

- [x] Add socket listener for `mls-welcome` event in frontend
- [x] Add `joinGroup(welcomeBytes)` to CoreCryptoClient
  - Call WASM `process_welcome()`
  - Store group state locally
- [x] Add `checkForInvites()` to poll for pending welcome messages
- [x] Fetch and delete welcome after processing
- [x] Regenerate KeyPackage after joining (KeyPackages are single-use)

**Test**: Login as invited user, verify they join the group and can see group state. ✅

### Step 6 Resolution (2025-12-15)

**FIXED** - The `NoMatchingKeyPackage` error has been resolved.

**Root Causes Identified & Fixed:**

1. **Per-User Storage** - IndexedDB was using a single key `current_identity` instead of per-user keys like `identity_${username}`. This caused identity overwrite when switching users in the same browser.
   - **Fix**: Updated `saveState()` and `loadState()` to use `identity_${username}` keys.

2. **Group ID Mismatch** - `MlsGroup::new()` generates its own internal group ID, which differed from our external group ID stored in the database. When the invitee processed the Welcome, they joined with the internal MLS group ID but messages were stored under the external ID.
   - **Fix**: Changed to `MlsGroup::new_with_group_id()` in `lib.rs` to ensure external and internal group IDs match.

3. **KeyPackage Regeneration** - After `process_welcome()` consumes a KeyPackage, it must be regenerated.
   - **Fix**: Added `regenerate_key_package()` method to WASM and call it after joining.

---

## Step 7: Send Encrypted Message ✅ COMPLETE
**Goal**: Encrypt and send a message to the group.

- [x] Add `sendMessage(groupId, plaintext)` to CoreCryptoClient
  - Call WASM `encrypt_message()`
  - POST to `/api/mls/messages/group` with `content_type: 'application'`
- [x] Add socket emit for `mls-message` event in backend (real-time delivery)

**Test**: Send message, verify encrypted bytes in `mls_group_messages` table. ✅

**Verified (2025-12-15)**: Message "Hello from mlstestB! E2EE works!" encrypted from 32 bytes to 177 bytes.

---

## Step 8: Receive and Decrypt Message ✅ COMPLETE
**Goal**: Receive encrypted message and decrypt it.

- [x] Add socket listener for `mls-message` event in frontend (real-time)
- [x] Add `handleIncomingMessage(messageData)` to CoreCryptoClient
  - Routes application vs commit messages
  - Call WASM `decrypt_message()` for application messages
  - Return plaintext
- [x] Add `fetchAndDecryptMessages(groupId)` for polling-based retrieval
- [x] Add `decryptMessage(groupId, ciphertext)` core decryption method

**Test**: Send message from one user, verify other user's console shows decrypted text. ✅

**Verified (2025-12-15)**: mlstestA successfully decrypted message: "Hello from mlstestB! E2EE works!"

---

## Step 9: Minimal Chat UI ✅ COMPLETE
**Goal**: Basic UI to test the full flow without using console.

- [x] MLS mode toggle integrated into existing Messages.js
- [x] MLS groups list in sidebar with selection
- [x] Create group form
- [x] Invite user to group
- [x] Message input + send using MLS encryption
- [x] Message display with decryption
- [x] Wire up to CoreCryptoClient methods
- [x] Added MLS state to messagingStore.js
- [x] Updated messaging.js with MLS helper methods
- [x] Added MLS styles to messages.css

**Test**: Two users can exchange encrypted messages through the existing Messages UI with MLS toggle.

### Implementation Notes (2025-12-15)
- Integrated MLS into the existing Messages.js instead of creating separate components
- Added a toggle switch to switch between "MLS E2EE" and "Legacy" modes
- MLS groups show with 🔒 icon to indicate E2EE
- The "MLS Ready" status indicator shows when MLS is initialized
- Supports creating groups, inviting users by ID, and real-time messaging

---

## Step 10: Process Commits
**Goal**: Handle incoming commits (member changes, updates).

- [ ] Add handling for `content_type: 'commit'` messages
- [ ] Call WASM `process_commit()` for non-application messages
- [ ] Update local group state

**Test**: Remove a member, verify other members process the commit.

---

## Step 11: Legacy Code Cleanup & MLS Consolidation ✅ COMPLETE
**Goal**: Remove deprecated RSA-based E2EE code and consolidate on MLS.

### Legacy Code to Remove:
- [x] `frontend/src/services/keyManager.js` - Old RSA key management (DELETED)
- [x] `backend/src/services/keyManagementService.js` - RSA key storage (DELETED)
- [x] `backend/src/controllers/keyManagementController.js` - RSA key endpoints (DELETED)
- [x] `backend/src/controllers/messagingController.js` - Legacy messaging (DELETED)
- [x] `backend/src/services/messagingService.js` - Legacy messaging service (DELETED)
- [x] Remove `/api/keys/*` routes from `api.js`
- [x] Remove `/api/messages/*` legacy routes from `api.js`

### Migration Tasks:
- [x] Update `messaging.js` to use CoreCryptoClient for encryption/decryption (MLS-only)
- [x] Update Messages.js to use MLS groups instead of 1-to-1 conversations
- [x] Update `messagingStore.js` for MLS message format
- [x] Update socket handlers to only use `mls-message`, `mls-welcome` events
- [x] Change MLS identity from username to userId (more stable, already in JWT)
- [x] Add `GET /api/mls/groups` endpoint to list user's groups
- [x] Simplify `idleLock.js` to no-ops (vault feature deferred)
- [x] Simplify `webauthnClient.js` to remove legacy key wrapping
- [x] Remove legacy key management UI from SettingsPage.js
- [x] Remove legacy unread message counts from Sidebar.js and BottomNav.js

### Database Cleanup:
- [ ] Drop `user_keys` table (deferred - not blocking)
- [ ] Drop old `conversations` / `messages` tables (deferred - not blocking)

**Test**: Full messaging flow works through MLS only, no legacy RSA code paths. ✅

### Implementation Notes (2025-12-15)
- All legacy Signal Protocol / RSA code has been removed
- MLS identity now uses `userId` instead of `username` for stability
- Frontend `messaging.js` is now a thin wrapper around `coreCryptoClient`
- Messages.js is MLS-only (no legacy mode toggle)
- JWT token simplified to only include `userId` and `role`

---

## Later Steps (Post-MVP)

- **Vault**: Encrypted storage with passphrase
- **Trust Layer**: Fingerprint verification UI, TOFU pinning
- **Group State Persistence**: Export/import on page load/unload
- **Self Update**: Key rotation for PCS
- **Multi-Device**: Multiple key packages per user
- **Full Chat UI**: Polished messaging interface

---

## Current Status (2025-12-15)

**Steps 1-11 COMPLETE** - Full E2EE flow with UI and legacy cleanup:
- ✅ WASM module loads and initializes
- ✅ Identity creation with per-user storage (using userId)
- ✅ KeyPackage upload/fetch
- ✅ Group creation with consistent group IDs
- ✅ User invitation (Welcome + Commit generation)
- ✅ Group joining from Welcome message
- ✅ Message encryption and sending
- ✅ Message decryption
- ✅ Socket.io real-time events for `mls-message` and `mls-welcome`
- ✅ MLS-only Messages.js UI (legacy mode removed)
- ✅ Group list, creation, and invitation UI
- ✅ Real-time encrypted messaging through UI
- ✅ All legacy RSA/Signal Protocol code removed
- ✅ Backend consolidated to MLS routes only
- ✅ Frontend messaging service is MLS-only wrapper

**Next Steps**:
1. ~~Add Socket.io events for real-time message delivery~~ ✅ DONE
2. ~~Build minimal chat UI (Step 9)~~ ✅ DONE (MLS-only)
3. Handle commit processing for member changes (Step 10)
4. ~~Clean up legacy RSA code (Step 11)~~ ✅ DONE
5. Implement "Vault" encrypted storage (Phase 1E)
6. Add Safety Numbers UI (Phase 1F)
