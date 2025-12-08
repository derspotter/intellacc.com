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

## Step 6: Join Group from Welcome
**Goal**: Process incoming Welcome and join the group.

- [ ] Add socket listener for `mls-welcome` event in frontend
- [ ] Add `joinGroup(welcomeBytes)` to CoreCryptoClient
  - Call WASM `process_welcome()`
  - Store group state locally
- [ ] Fetch and delete welcome after processing

**Test**: Login as invited user, verify they join the group and can see group state.

---

## Step 7: Send Encrypted Message
**Goal**: Encrypt and send a message to the group.

- [ ] Add `sendGroupMessage(groupId, plaintext)` to CoreCryptoClient
  - Call WASM `encrypt_message()`
  - POST to `/api/mls/messages/group` with `content_type: 'application'`
- [ ] Add socket emit for `mls-message` event in backend

**Test**: Send message, verify encrypted bytes in `mls_group_messages` table.

---

## Step 8: Receive and Decrypt Message
**Goal**: Receive encrypted message and decrypt it.

- [ ] Add socket listener for `mls-message` event in frontend
- [ ] Add `handleIncomingMessage(groupId, ciphertext)` to CoreCryptoClient
  - Call WASM `decrypt_message()`
  - Return plaintext
- [ ] Log decrypted message to console (temporary)

**Test**: Send message from one user, verify other user's console shows decrypted text.

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

## Current Starting Point

Based on the codebase review:
- WASM module exists and has core functions
- `CoreCryptoClient` has init and identity bootstrap
- Backend has MLS routes for key packages and messages
- Socket infrastructure exists but no MLS events yet

**Recommended first action**: Run Step 1 to verify everything loads correctly.
