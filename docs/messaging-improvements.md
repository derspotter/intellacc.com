## Messaging Plan (Consolidated: DRY + Improvements + Roadmap)

This document consolidates our prior DRY messaging plan and the messaging improvements plan into a single source of truth. It captures what is shipped, what remains, and how we will migrate to a modern, forward-secure E2EE stack.

> **Note:** `@signalapp/libsignal-client` and `@matrix-org/olm` are no longer bundled in the frontend. The legacy wrappers remain for archival reference while we pivot to Wire MLS.

### Current State (Shipped)
- Idempotent init: Messaging service is a singleton; handlers are registered once.
- Centralized joins: All room joins (predictions, profile, authenticate, messaging) happen in `socket.joinUserRooms()`.
- Emit queue + flush: Socket emits are buffered when offline (cap ≈50) and flushed on connect.
- DEV-only logs: Socket/messaging/UI logs are gated under `import.meta.env.DEV`.
- Event de-dup: Store tracks `lastSeenMessageId` per conversation; replayed events are ignored.
- Unified event path: `newMessage` and `messageSent` share a single handler path to avoid drift.
- Pagination meta + older loading: `messagesMeta` keeps `lastFetchedTs`, `oldestTime`, `hasMore`; `loadOlder()` uses `before`.
- Freshness gate: Reselect within 30s does not refetch unless marked stale by background events.
- DRY identity: Use `getTokenData()` (auth) and store `currentUserId`; no ad‑hoc JWT parsing in messaging.
- Client acks: Client generates `clientId` for sends; optimistic “pending” flips to “sent” on ack without duplicates (server echoes `clientId`).
- Backend payloads: Socket payloads include `created_at` (and echo `clientId`) for client-side ordering/reconciliation.

### DRY Principles & Architecture
- Store is the source of truth: normalization, dedupe, participant labeling (`displayName`), `lastTime`/`lastTs` for sorting.
- Render from plain projections: sidebar uses `sidebarItems` (filtered/sorted) to avoid heavy recomputation during render.
- Clear layering: socket → connection + room membership; messaging → envelopes, decrypt, reconcile; store → state + projections.
- Minimal updates: selected conversation fast‑path appends; unselected bumps time/unread and marks stale for next view.

### Integrity Strategy (Chosen for Phase 1.3)
- Choice: Option A (pragmatic) — rely on AEAD integrity and drop extra `contentHash` enforcement.
- Implementation:
  - Backend: `contentHash` is optional; if provided and malformed, request is rejected. Otherwise not required.
  - Frontend: remove additional hash verification on decrypt; rely on AES‑GCM integrity.
  - Rationale: reduces redundancy and surface area before migrating to libsignal, which provides authenticated encryption and stronger guarantees.

- ### Phase 1.3 — Work Completed + Remaining
- Integrity (Option A): implemented (backend optional `contentHash`; client verification removed).
- Remaining in 1.3
  - Tests: add unit tests for ack reconciliation and freshness gate; add backend test to accept messages without `contentHash`.
  - Dev noise: gate or remove residual console logs in store/service.
- Tests & hardening
  - Frontend: unit tests for ack reconciliation (pending→sent), freshness gate (no refetch <30s unless stale), event de‑dup.
  - Backend: controller tests for `clientId` passthrough; socket payload includes `created_at` and `clientId`.
- Dev noise: Gate or remove residual console logs in store/service.

### Phase 2 — Migration to libsignal (Modern E2EE)
- Objectives: Forward secrecy, out‑of‑order tolerance, authenticated sender identity; reduce custom crypto surface.
 - Library (frontend): `@signalapp/libsignal-client` (WASM) — official Signal client for web; replaces deprecated Node/JS libs.
- Library (backend): stays Node for API endpoints; no Rust required in frontend. The WASM module is loaded from JavaScript.
- Server endpoints (minimal):
  - Publish: identity public key, signed prekey, batch of one‑time prekeys.
  - Fetch: key bundles per user; consume one‑time prekeys.
- Client storage (IndexedDB):
  - Identity keypair, signed prekey, one‑time prekeys, and per‑conversation session state (ratchets).
- Message flow (new conversations):
  1) Bootstrap sessions using recipient’s key bundle (consuming a one‑time prekey).
  2) Send/receive with Double Ratchet; persist session state.
  3) Use AEAD provided by the protocol; remove custom `contentHash` entirely.
- Migration strategy:
  - Legacy compat: existing conversations remain RSA/AES until upgraded; new conversations default to Signal sessions.
  - Per‑conversation “encryption mode” flag; support opt‑in upgrade on first post‑migration message.
- Phased delivery:
  1) Key provisioning endpoints + client bootstrap UI.
  2) Session establishment for 1:1 chats; store session state.
  3) Hook messaging service to Signal encrypt/decrypt for new chats.
  4) Backward compatibility layer for legacy messages.
  5) Observability + recovery strategies (session reset, rekey).
- Testing:
  - Unit: session lifecycle, out‑of‑order delivery, ratchet step correctness.
  - Integration: key bundle publish/fetch, session creation/restore, multi‑device behavior (future).

Status: Scaffolding started (Single‑mode target)
- Decision: Single secure mode — Signal only. No per‑conversation toggle in the final design.
- Backend endpoints/tables: added (`/api/e2ee/keys/{identity,prekeys,bundle}` + tables: e2ee_devices, e2ee_signed_prekeys, e2ee_one_time_prekeys).
  - Added rate limits for `/api/e2ee/keys/*` endpoints and atomic reserve/consume semantics for one‑time prekeys.
- Frontend scaffolding:
  - API client: `api.e2ee.{publishIdentity,publishPrekeys,getBundle}`.
  - Key Manager: `frontend/src/services/signalKeyManager.js` (uses `signalLib` wrapper; handles generate + publish).
 - Session Manager: `frontend/src/services/signalSessionManager.js` (uses `signalLib` for ensure/encrypt/decrypt and will persist sessions).
  - Protocol Store: `frontend/src/services/signalProtocolStore.js` scaffold mirrors common libsignal store methods (`getIdentityKeyPair`, session load/store, etc.) to ease wiring to `@signalapp/libsignal-client`.
- Storage Adapters: `frontend/src/services/signalStorage.js` (identity, prekeys, sessions) — in-memory fallback plus `signalIndexedDB.js` for IndexedDB persistence (at‑rest encryption to follow).
 - Storage Adapters: `frontend/src/services/signalStorage.js` (identity, prekeys, sessions) — in-memory fallback plus `signalIndexedDB.js` for IndexedDB persistence with lightweight at‑rest encryption (AES‑GCM via cryptoService). Key material never leaves the device.
- Adapter: `frontend/src/services/signalAdapter.js` (single‑mode encrypt/decrypt routing).
- Store: single‑mode; removed per‑conversation mode setter.
- Wrapper: `frontend/src/services/signalLib.js` dynamically loads `@signalapp/libsignal-client` and falls back to placeholders only (no legacy libs). We will replace placeholders with real APIs; app keeps working during the switch.
 - Wrapper: `frontend/src/services/signalLib.js` now attempts real identity keypair generation via `IdentityKeyPair.generate()` when present, persisting via storage; guarded fallbacks remain to keep tests/runtime green.
 - Session flow: `signalSessionManager.ensureSession(peer)` fetches the peer bundle and calls `signalLib.ensureSession(peer, bundle)`. The wrapper attempts to build a real session using `PreKeyBundle + SessionBuilder` (guarded); session state is persisted via storage.
  - Encrypt/decrypt flow: `signalSessionManager` now passes `peerUserId` into `signalLib.encrypt/decrypt`, enabling the wrapper to address the correct session (and to call `SessionCipher` when wired).
 - Bugfix: removed an undefined variable reference in `decryptMessages()` when deriving conversationId for Signal decrypt.

Next (Phase 2.2)
- Frontend: adopt `@signalapp/libsignal-client` in `signalLib` and implement real identity/prekey/session generation + Double Ratchet. Persist identity + session state in IndexedDB with at‑rest encryption. All new sends already use Signal; legacy decrypt remains for old messages.
- Backend: (already added) atomic reserve/consume for one‑time prekeys; add rate limits + optional device registry and monitoring for prekey inventory.
- Tests: add frontend unit tests for session lifecycle (mock storage), adapter wiring, and decrypt path; expand backend tests for negative cases (no identity, no prekeys, double consume).

Implementation Notes
- Deprecation: `libsignal-protocol-js` is deprecated. We will migrate to `@signalapp/libsignal-client` for browser (JS/WASM) support.
- Frontend is not “in Rust”: the WASM module is loaded from JavaScript. No Rust code is added to the app; only the official WASM client is used.
- Storage adapters (browser):
  - Identity store: persist identity keypair (Curve25519) in IndexedDB (at‑rest encrypted).
  - Prekey store: persist signed prekey + one‑time prekeys and mark used.
  - Session store: persist per‑peer Double Ratchet state; supports restore and out‑of‑order delivery.
- Bootstrap: fully automatic after login — generate/publish identity, generate/publish prekeys, replenish when low, rotate signed prekey periodically. Retries with backoff.
- The adapter surface (`signalAdapter`, `signalSessionManager`) is stable; swapping from placeholders to the real lib requires no changes in messaging code.

#### Phase 2.1 — Detailed Design (API, Data, Client)

Backend API (minimal, auth required)
- POST `/e2ee/keys/identity`
  - Body: `{ deviceId?: string, identityKey: string(base64 Curve25519), signingKey: string(base64 Ed25519) }`
  - Stores device identity pubkeys; never stores private keys.
- POST `/e2ee/keys/prekeys`
  - Body: `{ deviceId?: string, signedPreKey: { keyId: number, publicKey: string(base64 Curve25519), signature: string(base64) }, oneTimePreKeys: Array<{ keyId: number, publicKey: string(base64 Curve25519) }> }`
  - Replaces signed prekey; upserts/rotates one‑time prekeys.
- GET `/e2ee/keys/bundle?userId=...&deviceId?`
  - Response: `{ identityKey, signedPreKey: { keyId, publicKey, signature }, oneTimePreKey?: { keyId, publicKey } }`
  - Server marks selected one‑time prekey as reserved/used atomically when served.
- POST `/e2ee/keys/consume`
  - Body: `{ userId, deviceId, keyId }` (optional if GET marks used atomically).

Data model (tables)
- `e2ee_devices(user_id, device_id, identity_pub, signing_pub, created_at)`
- `e2ee_signed_prekeys(user_id, device_id, key_id, public_key, signature, created_at, expires_at)`
- `e2ee_one_time_prekeys(user_id, device_id, key_id, public_key, used boolean default false, used_at)`
- Indexes on `(user_id, device_id)` and unique `(user_id, device_id, key_id)`.

Client components
- Key Manager (Signal):
  - Generate identity keypair (Curve25519) + signing key (Ed25519).
  - Generate signed prekey and a batch of one‑time prekeys; upload bundle.
  - Rotate signed prekey periodically; replenish one‑time prekeys when low.
- Session Manager:
  - `ensureSession(peerUserId[, peerDeviceId])` → creates/loads a libsignal session using key bundle.
  - `encrypt(conversationId, plaintext)` → returns ciphertext envelope + metadata.
  - `decrypt(conversationId, envelope)` → returns plaintext; handles PreKeySignalMessage vs SignalMessage.
  - Persist session state and counters in IndexedDB; at rest encrypted (Argon2id + AES‑GCM).

Transport and storage
- Envelope stored in existing `messages.encrypted_content` as base64‑encoded Signal message.
- `message_type` can indicate `signal` vs `legacy` (for transitional UI/state).
- Server treats ciphertext as opaque; no extra processing.

Adapter layer (frontend)
- `encryptionMode` per conversation: `legacy | signal`.
- Messaging service delegates to Signal adapter when `signal`.
- Backward compatibility: display legacy messages; new sends use Signal in signal‑mode threads.

Phased rollout steps
1) Provision & publish keys (single‑device); add bootstrap UI and health checks.
2) Establish sessions for new 1:1 conversations by default (signal mode flag on creation).
3) Send/receive via Signal; persist/restore sessions; handle reconnect and out‑of‑order delivery.
4) Add “Upgrade to Signal” action for legacy threads (mutual opt‑in); persist mode on conversation record/client cache.
5) Add multi‑device support (device registry + fan‑out per device) as a follow‑up phase.

Acceptance (Phase 2.1–2.3)
- New conversations exchange messages using Signal, with forward secrecy and post‑compromise security.
- Legacy threads remain readable; new sends default to Signal only after explicit upgrade.
- Sessions survive reloads; out‑of‑order and replay handled by libsignal state.
- No private key material ever leaves the client; server only stores public material.

### Acceptance Criteria (Current + Upcoming)
- No duplicate connect handlers; room joins are centralized in socket.
- `newMessage`/`messageSent` share one handler; duplicate events ignored via store meta.
- Reselect within 30s does not refetch unless stale; “Load older” uses `oldestTime`.
- Identity is retrieved via `getTokenData()`/store; no ad‑hoc JWT parsing.
- Pending → sent flips via `clientId` reconciliation; no duplicate inserts or unnecessary GETs.
- Integrity strategy implemented and documented (Option A or B) with tests.
- Phase 2 plan, endpoints, and storage design documented; initial scaffolding reviewed.

### Risks & Mitigations
- Offline queue growth: capped; consider skipping transient events (typing) while offline.
- Handler drift/regressions: unified envelope handler + tests reduce drift risk.
- Migration complexity: phased rollout with per‑conversation mode and legacy fallback; clear recovery path for session resets.

### References (Code)
- Frontend: `frontend/src/services/socket.js`, `frontend/src/services/messaging.js`, `frontend/src/stores/messagingStore.js`, `frontend/src/pages/Messages.js`, `frontend/src/components/profile/MessageButton.js`, `frontend/src/utils/messagingUtils.js`
- Backend: `backend/src/services/messagingService.js`, `backend/src/controllers/messagingController.js`
