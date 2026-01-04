# MLS / Keystore Diagnosis

## High Severity
None found in the latest pass.

## Medium Severity
None found in the latest pass.

## Low Severity

### DM validation edge case (coreCryptoClient.js:1991)

**Issue:** `validateStagedCommit()` rejects DM commits with `adds.length > 1`, but the overall DM logic assumes exactly 2 participants. Edge case unclear: if one participant leaves a DM, can they be re-added? Current logic would allow it since `adds.length === 1` passes.

**Status:** Policy-dependent. This is only a bug if DM membership is intended to be immutable once a participant leaves.

### `validateStagedCommit()` reused for proposals (coreCryptoClient.js:2261)

**Issue:** `processProposal()` calls `validateStagedCommit()` for policy validation. This works semantically but assumes `process_proposal` WASM function returns the same summary structure as `process_commit`. Should verify this assumption holds.

**Status:** Likely false alarm. `process_proposal()` returns `adds/updates/removes/epoch/aad_hex` (same fields used by validation), so structure compatibility holds.

### External senders not validated (coreCryptoClient.js:480-506)

**Issue:** `createGroup()` with external senders passes the identity/signatureKey data through without validation. Should verify signature keys are valid format/length before calling WASM.

**Status:** Partial. Type conversion exists, but there is no length/format check; this is a hardening item.

## OpenMLS Book Deviations (Remaining)
- LeafNode lifetime max-range enforcement is applied to KeyPackages (adds/readd/reboot and fetched packages), but staged-welcome member inspection doesn't expose LeafNodes, so max-range can't be checked for existing members during join. OpenMLS still validates current lifetimes when staging a Welcome. See `openmls-wasm/OpenMLS Book.txt:3490-3504`.

## Resolved
- Two-phase join APIs (`stageWelcome`, `getStagedWelcomeInfo`, `acceptStagedWelcome`, `rejectStagedWelcome`) are implemented and expose member credentials for inspection. See `openmls-wasm/OpenMLS Book.txt:1779-1786`. Code: `openmls-wasm/src/lib.rs`, `frontend/src/services/mls/coreCryptoClient.js`.
- Welcome handling now always stages and validates before joining (no direct `joinGroup()` use in the invite flow).
- AAD metadata binding is enforced for application/commit/proposal messages (set on send, validated on decrypt/commit).
- Key package lifetimes are uploaded and filtered by validity; clients rotate expiring packages and publish a last-resort package per device.
- Key package lifetime range is validated on add/readd/reboot proposals and when fetching key packages.
- Confirmation tag exchange, fork detection callbacks, and readd/reboot helpers are wired into the MLS client.
- Message padding is configured (32-byte padding) for group create/join configs.
- Application-level semantic validation now runs on staged commits before merge, enforcing BasicCredentials and app-specific identity rules. See `openmls-wasm/OpenMLS Book.txt:3515`. Code: `openmls-wasm/src/lib.rs`, `frontend/src/services/mls/coreCryptoClient.js`.
- Server-side membership is synced from MLS state snapshots after joins/commits, so the relay uses cryptographic truth. Code: `frontend/src/services/mls/coreCryptoClient.js`, `backend/src/routes/mls.js`, `backend/src/services/mlsService.js`.
- Server-side commit epoch uniqueness now rejects duplicate commits per epoch. See `openmls-wasm/OpenMLS Book.txt:1811`. Code: `backend/src/services/mlsService.js`, `backend/src/routes/mls.js`, `backend/migrations/20260103_add_mls_relay_queue_metadata.sql`.
- Out-of-order handling configured via `SenderRatchetConfiguration` (tolerance + forward distance). See `openmls-wasm/OpenMLS Book.txt:3752`. Code: `openmls-wasm/src/lib.rs`.
- Commits are staged and merged after delivery service acceptance; pending commits can now be cleared on rejection (no auto-merge inside `add_member`). See `openmls-wasm/OpenMLS Book.txt:1716`.
- Welcome delivery now waits for commit POST success, avoiding a Welcome-before-acceptance path. See `openmls-wasm/OpenMLS Book.txt:556`.
- Optional GroupInfo from `add_members` is serialized, relayed, and exposed to clients for verification. See `openmls-wasm/OpenMLS Book.txt:780`.
- Welcome inspection/approval is now possible via a pending-invites flow (invites are held until accepted or rejected). See `openmls-wasm/OpenMLS Book.txt:556`.
- `frontend/src/services/mls/coreCryptoClient.js` no longer persists MLS state to `openmls_storage`; `saveState()` only drains in-memory events and vault persistence handles encryption.
- `frontend/src/services/vaultService.js` now forwards the `userId` into `checkKeystoreExists()`, so keystore ownership validation is enforced.
- `backend/src/services/mlsService.js` now validates sender group membership before storing welcome or group messages.
- `frontend/src/services/mls/coreCryptoClient.js` now clears both `state` and `granular_events` during `clearState()` / `panicWipe()`.
- `processCommit()` is now implemented and commit routing uses `messageType`.
- `sendMessage()` now handles `{ queueId }` and stores sent-message history with a real ID.
- Change-password SQL placeholders are fixed.
- MLS init no longer calls deleted `checkForInvites()`; it uses `syncMessages()` instead.
- Recipient DMs now appear after a welcome because the handler refreshes direct messages alongside MLS groups.
- `syncMessages()` is serialized and deduplicated by message id to prevent concurrent processing.
- `uploadKeyPackage()` skips the placeholder upload when no device id exists, avoiding duplicate key packages.
- Commit relays now exclude newly invited users so welcome joins do not see `WrongEpoch` commits.
- Relay queue payloads now include `sender_user_id`, so message sender lookups use real user IDs (no `/api/users/:id` 404s).
- Legacy `openmls_storage` is no longer written; all MLS state is stored encrypted in `intellacc_keystore` via VaultService, and `clearState()` deletes the legacy DB if present.
- `/mls/messages/group` is confirmed relay-only. Messages are stored temporarily in `mls_relay_queue` with 30-day expiry. Persistent history is encrypted client-side in IndexedDB (`intellacc_keystore`).
- External commits are supported: group members can export/publish GroupInfo (with ratchet tree), and new members can join via `external_commit_builder` with optional PSK proposals. Code: `openmls-wasm/src/lib.rs`, `frontend/src/services/mls/coreCryptoClient.js`, `backend/src/routes/mls.js`, `backend/src/services/mlsService.js`.
- PSK support is implemented for external PSKs: clients can generate/store PSKs, propose them, and commit pending proposals. Code: `openmls-wasm/src/lib.rs`, `frontend/src/services/mls/coreCryptoClient.js`.
- External sender support is wired through group context extensions and proposal processing (with pending-proposal commit flow). Code: `openmls-wasm/src/lib.rs`, `frontend/src/services/mls/coreCryptoClient.js`.
- Welcome sender validation now contributes to the `valid` verdict, and sender lifetime (when present) is surfaced from WASM and validated. Code: `openmls-wasm/src/lib.rs`, `frontend/src/services/mls/coreCryptoClient.js`.
- `joinGroup()` now routes through two-phase validation flow (`stageWelcome` → `validateStagedWelcomeMembers` → `acceptStagedWelcome`) instead of calling `process_welcome()` directly. Code: `frontend/src/services/mls/coreCryptoClient.js:1081-1099`.
- `commitPendingProposals()` now captures rollback state before committing and restores on failure. Also broadcasts confirmation tag after success and tracks failed welcome recipients. Code: `frontend/src/services/mls/coreCryptoClient.js:2271-2378`.
- `joinGroupByExternalCommit()` now broadcasts confirmation tag after successful join for fork detection. Code: `frontend/src/services/mls/coreCryptoClient.js:722-728`.
- Commit/proposal rejection events are now emitted via `emitCommitRejected()` with reason and type. UI can subscribe via `onCommitRejected()`. Code: `frontend/src/services/mls/coreCryptoClient.js:2833-2858`.

## Open Questions
None.

---

## Missing Features

### MLS Protocol Requirements (from OpenMLS Book)

These are core MLS operations described in the OpenMLS Book that are not yet implemented:

| Feature | Book Reference | Priority | Status | Description |
|---------|----------------|----------|--------|-------------|
| `self_update()` | Lines 1168-1210 | **High** | ✅ Implemented | Key rotation for Post-Compromise Security (PCS). WASM: `self_update()`, JS: `selfUpdate(groupId)`. |
| `remove_member()` | Lines 1005-1017 | **Medium** | ✅ Implemented | Remove a member from a group by leaf index. WASM: `remove_member()`, JS: `removeMember(groupId, leafIndex)`. |
| `leave_group()` | Lines 1276-1291 | **Medium** | ✅ Implemented | Voluntarily leave a group (creates proposal). WASM: `leave_group()`, JS: `leaveGroup(groupId)`. |
| Full credential validation on join | Lines 1779-1786 | **Medium** | ✅ Implemented | Welcome flow stages and validates credentials before accepting. |
| AAD metadata binding | Lines 1248-1267 | **Low** | ✅ Implemented | AAD is set on send and validated on decrypt/commit. |
| Fork detection | Lines 1810-1821 | **Low** | ✅ Implemented | Clients exchange confirmation tags and emit fork-detection callbacks. |
| Fork resolution helpers | Lines 1816-1821 | **Low** | ✅ Implemented | `recover_fork_by_readding` and `reboot_group` helpers are exposed and wrapped. |
| LeafNode lifetime validation | Lines 3490-3504 | **Medium** | Partial | KeyPackage lifetime range is enforced for adds/readd/reboot/fetch, but staged Welcome inspection cannot validate existing members' LeafNode ranges. |
| Key package expiry management | Lines 2512-2552 | **Medium** | ✅ Implemented | Key package lifetimes are stored/filtered; clients rotate expiring packages and upload a last-resort package. |
| PSK (Pre-Shared Key) support | Lines 2753-2761, 3373-3441 | **Low** | ✅ Implemented | External PSKs can be generated, stored, proposed, and committed; resumption PSK retention is bounded via join config. |
| External commits | Lines 706-770 | **Low** | ✅ Implemented | GroupInfo export/publish + external commit join flow implemented. |
| External senders | Lines 869-960, 1112-1158 | **Low** | ✅ Implemented | External sender extension support + proposal processing/commit flow implemented. |
| Message padding | Lines 246-250 | **Low** | ✅ Implemented | Join/create configs set a 32-byte padding size. |
| CommitBuilder API | Lines 798-809, 1845+ | **Low** | Partial | Commit builder is used internally (readd/reboot/external commit), but there is no general JS wrapper to build multi-proposal commits or run app-policy closures pre-commit. |
| `add_members_without_update()` | Lines 836-851 | **Low** | Missing | No wrapper; only the `add_members` path is exposed (always includes a path/update). |
| `propose_add_member()` | Lines 856-858, 1591 | **Medium** | Missing | No API to generate add proposals (only receiving/processing). |
| `propose_remove_member()` | Lines 1027-1038 | **Medium** | Missing | No API to generate remove proposals (outside `leave_group`). |
| `propose_self_update()` | Lines 1218-1230 | **Medium** | Missing | No API to propose leaf updates; only `self_update()` commit path. |
| `self_update_with_new_signer()` | Lines 1187-1213 | **Low** | Missing | No support for rotating credential/signature keys via new signer bundle. |
| External proposals | Lines 1112-1115 | **Low** | Missing | No client API to craft external-sender proposals (only processing if delivered). |
| Custom proposals | Lines 1300-1306 | **Low** | Missing | No API for application-defined proposal types or capability advertisement. |
| Required capabilities & extension negotiation | Lines 320-521, 661 | **Low** | Partial | Group config/key packages are fixed defaults; no API to set required capabilities/leaf extensions or inspect GroupContext requirements at join time. |

### Application-Level Features (Not in OpenMLS Book)

These are application/UX features that enhance the E2EE experience but are not part of the MLS protocol:

| Feature | Priority | Description |
|---------|----------|-------------|
| TOFU pinning | **Medium** | Trust-On-First-Use: Store first-seen credential fingerprint per contact and warn on changes. Helps detect MITM attacks. |
| `is_verified` contact status | **Low** | Track which contacts have been manually verified via Safety Numbers comparison. |
| Persistent message deduplication | **Low** | Currently `processedMessageIds` is in-memory. If crash occurs between decrypt and ACK, message may be processed twice on restart. |
| Group admin controls | **Low** | Promote/demote admins, restrict who can add/remove members. |
| File/image attachments | **Low** | Encrypt file metadata, use presigned URLs for encrypted blob storage. |
| Message reactions | **Low** | React to messages with emoji. |
| Message editing/deletion | **Low** | Edit or delete sent messages (with appropriate E2EE considerations). |
| Read receipts | **Low** | Encrypted delivery/read confirmations. |
| Typing indicators | **Low** | Real-time typing status. |
| Disappearing messages | **Low** | Auto-delete messages after configurable time. |

### Implementation Notes

**`self_update()`, `remove_member()`, `leave_group()` - IMPLEMENTED (Jan 3, 2026)**

All three core MLS operations are now implemented:
- WASM functions in `openmls-wasm/src/lib.rs`
- JavaScript wrappers in `frontend/src/services/mls/coreCryptoClient.js`
- Helper: `getOwnLeafIndex(groupId)` to get your leaf index in a group

**Usage:**
```javascript
// Key rotation for PCS - call periodically
await coreCryptoClient.selfUpdate(groupId);

// Remove a member (need their leaf index)
const leafIndex = 2; // Get from group member list
await coreCryptoClient.removeMember(groupId, leafIndex);

// Leave a group voluntarily (sends proposal, another member must commit)
await coreCryptoClient.leaveGroup(groupId);

// Get your own leaf index
const myIndex = coreCryptoClient.getOwnLeafIndex(groupId);
```

**TODO:** Add UI buttons and automatic periodic `selfUpdate()` calls.

**Two-Phase Join APIs (staging + inspection) - IMPLEMENTED (Jan 3, 2026)**

Per OpenMLS Book (lines 1782-1786), applications should validate credentials when joining a group. The invite flow now stages and validates welcomes before accepting, and uses `acceptStagedWelcome()` instead of `joinGroup()`.

**WASM Functions:**
- `stage_welcome(welcome_bytes, ratchet_tree_bytes)` → Returns `welcome_id` (hex group ID)
- `get_staged_welcome_info(welcome_id)` → Returns `StagedWelcomeInfo` with sender and member credentials
- `accept_staged_welcome(welcome_id)` → Joins the group, returns `group_id_hex`
- `reject_staged_welcome(welcome_id)` → Discards the staged welcome
- `list_staged_welcomes()` → Lists all pending staged welcomes

**JavaScript Wrappers:**
```javascript
// Stage a welcome for inspection (don't auto-join)
const welcomeId = await coreCryptoClient.stageWelcome(welcomeBytes, ratchetTreeBytes);

// Get sender and member info for validation
const info = coreCryptoClient.getStagedWelcomeInfo(welcomeId);
// info = { group_id_hex, ciphersuite, epoch, sender: {...}, members: [{...}] }

// Validate members (enforces BasicCredential, checks identity format)
const validation = coreCryptoClient.validateStagedWelcomeMembers(welcomeId);
// validation = { valid: true/false, issues: [...] }

// Accept or reject based on validation
if (validation.valid) {
    const groupId = await coreCryptoClient.acceptStagedWelcome(welcomeId);
} else {
    coreCryptoClient.rejectStagedWelcome(welcomeId);
}

// List all pending invites
const pending = coreCryptoClient.listStagedWelcomes();
```

**TODO:** Add UI affordances for inspecting member fingerprints before accepting.

---

## Code Review: Codex Changes (Jan 3, 2026)

Reviewed ~1000 lines of new code in `frontend/src/services/mls/coreCryptoClient.js`.

### Verified Working

**AAD Binding (lines 101-148):**
- Payload structure: `{ v: 1, groupId, epoch, type, ts }`
- `setGroupAad()` called before all cryptographic ops (commits, application messages, proposals)
- Validation on decrypt checks groupId, epoch, type match

**Fork Detection (lines 1446-1536):**
- Three Maps track local/remote/sent confirmation tags per group per epoch
- `broadcastConfirmationTag()` sends encrypted system message after epoch advances
- `emitForkDetected()` notifies registered handlers on mismatch

**Two-Phase Welcome in `syncMessages()` (lines 1651-1718):**
- `stageWelcome()` → `validateStagedWelcomeMembers()` → `acceptStagedWelcome()`
- Supports UI approval flow via `welcomeRequestHandlers`
- Rejected welcomes properly discarded

**validateStagedCommit() (lines 1945-2035):**
- LeafNode lifetime range checks on adds/updates
- BasicCredential enforcement
- DM-specific rules (allowed participants, single add)
- Identity existence checks (no duplicate adds, no updates/removes of unknown members)

**processCommit() (lines 1864-1942):**
- Staging → AAD validation → policy validation → merge
- Rollback via `discard_staged_commit()` on failure
- Broadcasts confirmation tag after success

### WASM Bindings Verified

Confirmed these functions exist in `openmls-wasm/src/lib.rs`:
- `set_group_aad` (line 1364)
- `decrypt_message_with_aad` (line 1418)
- `process_commit` (line 1214)
- `merge_staged_commit` (line 1296)
- `discard_staged_commit` (line 1310)
- `create_group_with_external_senders` (line 439)
- `export_group_info` (line 505)
- `inspect_group_info` (line 524)
- `process_proposal` (line 1614)
- `clear_pending_proposals` (line 1700)
- `commit_pending_proposals` (line 1710)

---

## Deprecation Notice

The file `openmls-implementation-plan.md` is **deprecated** and should be archived or removed when convenient. This diagnosis file (`mls-diagnosis.md`) is now the single source of truth for MLS implementation status. The authentication/keystore architecture is documented in `authn-plan.md`.
