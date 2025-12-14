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
- [ ] Add socket emit for `mls-welcome` event in backend route

**Test**: Invite user, check `mls_welcome_messages` table for pending welcome.

---

## Step 6: Join Group from Welcome ✅ COMPLETE
**Goal**: Process incoming Welcome and join the group.

- [ ] Add socket listener for `mls-welcome` event in frontend
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
- [ ] Add socket emit for `mls-message` event in backend (real-time delivery)

**Test**: Send message, verify encrypted bytes in `mls_group_messages` table. ✅

**Verified (2025-12-15)**: Message "Hello from mlstestB! E2EE works!" encrypted from 32 bytes to 177 bytes.

---

## Step 8: Receive and Decrypt Message ✅ COMPLETE
**Goal**: Receive encrypted message and decrypt it.

- [ ] Add socket listener for `mls-message` event in frontend (real-time)
- [x] Add `handleIncomingMessage(messageData)` to CoreCryptoClient
  - Routes application vs commit messages
  - Call WASM `decrypt_message()` for application messages
  - Return plaintext
- [x] Add `fetchAndDecryptMessages(groupId)` for polling-based retrieval
- [x] Add `decryptMessage(groupId, ciphertext)` core decryption method

**Test**: Send message from one user, verify other user's console shows decrypted text. ✅

**Verified (2025-12-15)**: mlstestA successfully decrypted message: "Hello from mlstestB! E2EE works!"

---

## Step 9: Minimal Chat UI
**Goal**: Basic UI to test the full flow without using console.

- [ ] Simple group list component
- [ ] Simple message input + send button
- [ ] Simple message display area
- [ ] Wire up to CoreCryptoClient methods

**Test**: Two users can exchange encrypted messages through the UI.

---

## Step 10: Process Commits
**Goal**: Handle incoming commits (member changes, updates).

- [ ] Add handling for `content_type: 'commit'` messages
- [ ] Call WASM `process_commit()` for non-application messages
- [ ] Update local group state

**Test**: Remove a member, verify other members process the commit.

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

**Steps 1-8 COMPLETE** - Core E2EE flow works end-to-end:
- ✅ WASM module loads and initializes
- ✅ Identity creation with per-user storage
- ✅ KeyPackage upload/fetch
- ✅ Group creation with consistent group IDs
- ✅ User invitation (Welcome + Commit generation)
- ✅ Group joining from Welcome message
- ✅ Message encryption and sending
- ✅ Message decryption

**Next Steps**:
1. Add Socket.io events for real-time message delivery (`mls-message`, `mls-welcome`)
2. Build minimal chat UI (Step 9)
3. Handle commit processing for member changes (Step 10)
