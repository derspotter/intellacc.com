# Wire MLS Integration Plan

## Context
- Legacy Signal/libsignal implementation has been removed; MLS is the sole messaging path
- Replace legacy Signal/libsignal scaffolding with Wire's `@wireapp/core-crypto` TypeScript bindings (published from `crypto-ffi/bindings/js`, current tag `9.1.0`) to deliver browser-based MLS E2EE.
- Maintain existing messaging UX, socket plumbing, and store architecture while swapping the crypto/session layer.
- Project is open source, so GPL-3.0 obligations from Wire's distribution are acceptable and will be surfaced in our licensing docs.

## Objectives
- Provide forward-secure 1:1 and group messaging using MLS while preserving optimistic UI, pagination, and ack reconciliation.
- Minimize backend churn by introducing a thin MLS transport layer that satisfies the `MlsTransport` contract exposed in `CoreCryptoMLS.ts`.
- Document operational practices for credential issuance, keystore handling, and GPL-3.0 compliance.

## Scope
- **In scope:** frontend crypto/service layer, backend MLS transport endpoints, persistence for MLS artifacts, migration tooling, docs/tests.
- **Out of scope (initially):** multi-device session sync, attachment encryption overhaul, MLS federation.

---

## Architecture Overview
1. **Frontend (VanJS)**
   - Load the WASM artifact (`core-crypto-ffi_bg.wasm`) via `initWasmModule()` exported by `@wireapp/core-crypto` (`core-crypto-ffi/bindings/js/src/CoreCrypto.ts`).
   - Open the encrypted keystore using `openDatabase({ databaseName, key })` and pass the resulting `Database` into `await CoreCrypto.init(database)` (`CoreCryptoInstance.ts`).
   - Register delivery callbacks by implementing `MlsTransport` (with `sendCommitBundle`, `sendMessage`, `prepareForTransport`) and wiring it through `coreCrypto.provideTransport(transport)`.
   - Wrap MLS actions in `coreCrypto.transaction(ctx => …)` to access `CoreCryptoContext` methods such as `ctx.mlsInit`, `ctx.mlsCreateConversation`, `ctx.encryptMessage`, and `ctx.decryptMessage` while keeping our optimistic store updates intact.
   - Pull conversation metadata from `coreCrypto.conversationEpoch`, `coreCrypto.conversationCiphersuite`, `coreCrypto.clientPublicKey`, and `coreCrypto.isHistorySharingEnabled` to hydrate `messagingStore`.
   - Persist MLS state through the provided IndexedDB + AES-GCM keystore (`KEYSTORE_IMPLEMENTATION.html`) and gate unlock with our passphrase/biometric UX.

2. **Backend (Node/Express + Socket.IO)**
   - Mirror the `MlsTransport` contract: accept `CommitBundle` payloads (commit, optional welcome, `GroupInfoBundle`, optional encrypted message) and raw MLS application `Uint8Array`s emitted by the client.
   - Persist MLS blobs (`commit`, `welcome`, `group_info.payload`, application ciphertext) and retain epoch/sender metadata for replay or recovery.
   - Support `prepareForTransport` by packaging history secrets for delivery (e.g., storing `HistorySecret.clientId/data` and returning routing hints to the client).
   - Reuse JWT authentication to map requests to MLS identities (`WireIdentity`/`CredentialType.Basic`) and restrict fan-out to authorized conversation members.
   - Continue to emit Socket.IO events so realtime delivery works identically to the legacy stack; events will now carry MLS ciphertext plus metadata such as epoch and `senderClientId`.

3. **Credential Strategy**
   - Issue MLS credentials with `CredentialType.Basic` (Ed25519) keyed to our user IDs + device fingerprints.
   - Frontend requests a CSR via `ctx.provisionCredentialRequest`, backend signs it, and client completes provisioning with `ctx.completeCredentialProvisioning`; repeat on login to refresh expired certs.
   - Persist credential metadata in the keystore and expose status (valid, expiring, revoked) to the UI for troubleshooting.

4. **Deployment/DevOps**
   - Vendor the GPL-3.0 license and NOTICE from Wire Swiss GmbH; update our LICENSE/README accordingly.
  - Pin `@wireapp/core-crypto@^9.1.0` and monitor releases via Renovate, reviewing `https://wireapp.github.io/core-crypto/CHANGELOG.html` before upgrades.

---

## Implementation Phases

### Phase 0 — Foundation (Week 1)
- [x] Add `@wireapp/core-crypto@^9.1.0` to `frontend/package.json`; update Vite config to treat `core-crypto-ffi_bg.wasm` as a static asset (`optimizeDeps.exclude`, `assetsInclude`).
- [x] Create `frontend/src/services/mls/coreCryptoClient.js` that wraps `initWasmModule()` and `CoreCrypto.init` behind a `VITE_ENABLE_MLS` feature flag.
- [x] Document GPL-3.0 attribution for Wire in `LICENSE` and `README`.
  - `npm install` now pulls `@wireapp/core-crypto` directly from the registry; if the WASM must be served from a CDN set `VITE_CORE_CRYPTO_WASM_BASE` accordingly.

### Phase 1 — Frontend Bootstrap (Weeks 2-3)
- [ ] Call `await initWasmModule(import.meta.env.VITE_CORE_CRYPTO_WASM_BASE ?? undefined)` during app bootstrap; emit telemetry if the WASM load fails.
- [ ] Initialize the keystore via `openDatabase({ databaseName, key: DatabaseKey.Bytes(secret) })`; store the key securely (passphrase or OS keystore) and add unlock UX.
  - `ensureMlsBootstrap()` now calls `openDatabase` with a locally cached random key and opportunistically publishes generated keypackages via `/api/mls/key-packages`; passphrase storage/unlock flow remains TODO (`VITE_MLS_KEYPACKAGE_TARGET`, `VITE_MLS_KEYPACKAGE_UPLOAD_INTERVAL_MS` tune thresholds).
- [ ] Inside `CoreCrypto.transaction`, flow through `ctx.mlsInit`, `ctx.provisionCredentialRequest`, backend signature, and `ctx.completeCredentialProvisioning` to finish credential bootstrap.
- [ ] Register logging hooks using `setLogger` and `setMaxLogLevel` so MLS logs surface in dev builds (mapping to our console/logger service).
- [ ] Extend `messagingStore` to track `encryptionMode: 'mls'`, `conversationEpoch`, and `mlsCiphersuite` (via `coreCrypto.conversationEpoch` / `conversationCiphersuite`).
- [ ] Replace legacy encrypt/decrypt in `messaging-legacy/messaging.js` with MLS paths: `ctx.encryptMessage(conversationId, payload)` before hitting the transport and `ctx.decryptMessage(conversationId, ciphertext)` on receipt (guarded by the feature flag for rollback).
  - Socket layer now listens for `mls:commit`/`mls:message` events and marks conversations stale pending MLS-aware message rendering.

### Phase 2 — Backend Transport (Weeks 3-4)
- [x] Create Postgres tables mirroring `CommitBundle` (`mls_commit_bundles`), key packages (`mls_key_packages`), and raw MLS application ciphertext (`mls_messages`).
- [x] Implement API handlers that satisfy the `MlsTransport` callbacks:
  - `sendCommitBundle` → `POST /api/mls/commit`: persists bundle, queues Socket.IO fan-out (`mls:commit`).
  - `sendMessage` → `POST /api/mls/message`: stores ciphertext, emits `mls:message` with conversation + epoch metadata.
  - Key-package upload → `POST /api/mls/key-packages`: replaces stored packages per (userId, clientId, ciphersuite).
  - History secret placeholder → `POST /api/mls/history-secret`: validates membership + echoes `data` for local transport until DS forwarding is implemented.
- [ ] `prepareForTransport` → enhance `/api/mls/history-secret` to persist and fan-out history secrets once backend fan-out is available.
- [ ] Build a fan-out worker that drains pending MLS messages and pushes them to each participant (`messaging:${userId}` rooms) while tagging payloads with `messageId`, `clientId`, and epoch.
- [ ] Gate every endpoint with JWT auth → MLS identity mapping; deny requests for non-members and log anomalies.

### Phase 3 — End-to-End Messaging (Weeks 5-6)
- [ ] Wrap conversation lifecycle helpers around `CoreCryptoContext`: `ctx.mlsCreateConversation`, `ctx.mlsAddMembers`, `ctx.mlsRemoveMembers`, `ctx.commitPendingProposals`.
  - In progress: backend routes scaffolded (`/api/mls/credentials/*`, `/api/mls/messages/:conversationId`) with persistence; decrypt pipeline still returns ciphertext until core-crypto backend integration is ready.
- [ ] Adapt send pipeline: optimistically insert plaintext, but store MLS ciphertext/application payload returned by `ctx.encryptMessage`; on `decryptMessage`, surface `hasEpochChanged`, `commitDelay`, and `senderClientId` to the UI/store.
  - Frontend send/receive now routes through CoreCrypto (encrypt/decrypt) with optimistic MLS messages; awaiting backend decrypt pipeline for plaintext fetch.
- [ ] Persist `GroupInfoBundle.payload` alongside conversation records so new devices can join via external commit if needed.
- [ ] Show MLS diagnostics (epoch number, history sharing flag, credential expiry) in developer tools/support UI for debugging.
- [ ] Provide migration toggles: new conversations default to MLS; legacy threads remain readable until users trigger "Upgrade to MLS" (creates MLS group, sends welcome, locks legacy send).

### Phase 4 — Hardening & Launch (Weeks 6-7)
- [ ] Add unit/integration tests using Vitest + Playwright to cover credential bootstrap, `MlsTransport` retry/abort flows, decrypted buffered messages, and epoch observers.
- [ ] Implement retries/backoff honoring `MlsTransportResponse` semantics (retry vs abort) and exponential backoff for keystore unlock prompts.
- [ ] Conduct security review: confirm keystore entropy, credential storage, downgrade protections (reject legacy payloads once conversation is MLS), and logging hygiene.
- [ ] Update runbooks (upgrade procedure, keystore recovery, how to invalidate credentials) and ensure observability (metrics for WASM load, credential errors, transport retries).

---

## Detailed Task Breakdown

### Frontend
- Create `coreCryptoClient` module exporting `loadCoreCrypto`, `getCoreCryptoInstance`, and wrappers for `CoreCrypto.transaction`.
- Implement an `mlsMessagingService` that:
  - Calls `coreCrypto.provideTransport(transport)` with an object that forwards to our fetch/socket layer.
  - Uses `ctx.encryptMessage`, `ctx.decryptMessage`, `ctx.mlsStageProposal`, `ctx.mlsCommit` for group management.
  - Hooks `EpochObserver`/`HistoryObserver` to refresh `messagingStore` when `epochChanged` or history clients are materialized.
- Update UI components to surface MLS status (credential provisioned, epoch, history sharing) using selectors tied to `coreCrypto.conversationEpoch` and `coreCrypto.isHistorySharingEnabled`.
- Add error boundaries translating `CoreCryptoError` helpers (`isMlsDuplicateMessageError`, `isMlsStaleCommitError`, etc.) into user-visible toasts or silent retries.

### Backend
- Define TypeScript types aligning with `MlsTransport` payloads (`CommitBundle`, `HistorySecret`) to ensure shape parity.
- Add Express controllers for `/api/mls/commit`, `/api/mls/message`, `/api/mls/history-secret`, plus polling endpoints if needed for offline clients.
- Extend Socket.IO emitter to include MLS metadata (`epoch`, `senderClientId`, `groupInfoEncryptionType`) so the frontend can reconcile state.
- Introduce cron/worker scripts to expire orphaned welcome messages and purge retired MLS blobs.

### Tooling & Ops
- Add npm script (`npm run verify:core-crypto`) to ensure the WASM asset is copied to `dist/` and the bundle size stays within limits.
- Update Docker compose to mount the WASM artifact and expose new env vars (`MLS_TRANSPORT_BASE_URL`, `MLS_CREDENTIAL_ISSUER_KEY`).
- Configure CI jobs to run MLS-enabled integration tests in headless browsers and to lint for GPL notices.
- Set up Renovate (or equivalent) rules to watch `@wireapp/core-crypto`; auto-open PRs with changelog links.

---

## Testing Strategy
- **Unit tests:**
  - Frontend: mock `MlsTransport` and verify encrypt/decrypt round trips, credential bootstrap flow, and error mapping via `CoreCryptoError` helpers.
  - Backend: authorization tests for MLS endpoints, Postgres persistence of `CommitBundle`, Socket.IO broadcast contents.
- **Integration tests:**
  - Playwright run that boots two browsers, provisions credentials, exchanges MLS messages, validates epoch transitions and buffered message handling.
  - Group membership churn (add/remove) verifying new welcomes are persisted and served correctly.
- **Load tests:**
  - K6 or custom script hitting `/api/mls/commit` with concurrent commits to validate DB throughput and socket fan-out.

---

## Migration Plan
1. Ship Phase 0 with `VITE_ENABLE_MLS=false` and collect WASM load telemetry in staging.
2. Dogfood MLS by enabling the flag for internal accounts; gather metrics on credential bootstrap and transport retries.
3. Backfill existing conversation records with `encryptionMode='legacy'` and guard send UI with the new flag.
4. Roll out an "Upgrade to MLS" action that spins up an MLS conversation, broadcasts welcomes, and locks legacy sending.
5. Gradually expand MLS enablement to all users, monitor error rates/latency, and remove legacy crypto once adoption is complete.

---

## Risks & Mitigations
- **WASM load failures:** prefetch the module, cache-bust on deploy, and instrument retries with `setLogger` output.
- **Credential loss (cleared storage):** provide recovery flow that replays provisioning (issue new credential, rejoin groups) and warn users before logout.
- **Backend fan-out delays:** queue commits/messages with ack tracking, emit metrics on retry counts, and leverage `MlsTransportResponse` to backpressure clients.
- **GPL compliance drift:** automated lint in CI ensuring license text and attribution remain.
- **Upstream API changes:** pin versions, cover critical flows in CI, and stage upgrades with canary testing.

---

## Open Questions
- Do we support multi-device accounts in v1? If yes, we must extend credential issuance and MLS roster management for additional `ClientId`s per user.
- What is our story for message search while ciphertext remains opaque? (Likely client-side plaintext indexing.)
- Any regulatory/export requirements for MLS usage that must be documented for compliance?

## References
- `@wireapp/core-crypto` source: `https://github.com/wireapp/core-crypto`
- TypeScript API docs: `https://wireapp.github.io/core-crypto/main/typescript/index.html`
- Keystore details: `https://wireapp.github.io/core-crypto/KEYSTORE_IMPLEMENTATION.html`
- MLS RFC 9420: `https://datatracker.ietf.org/doc/rfc9420/`
- Legacy context: `docs/messaging-improvements.md`

## Upstream Wire References
*(Future work reminders: stage/push current MLS changes; teach messaging store/pages to process MLS ciphertext once backend decrypt APIs land; add `/api/mls/history-secret`.)*

### Wire Server MLS Insights (2025-10-08)
- **Deployment prerequisites**: Wire enables MLS by providing removal keys (one per supported ciphersuite) via `galley.secrets.mlsPrivateKeys.removal` and toggling `brig.config.optSettings.setEnableMLS`. Clients opt-in via `FEATURE_ENABLE_MLS`. We can omit removal keys for now (no server-side removals), but note the need if we implement admin-driven member removal later.
- **Key package lifecycle**: Wire offers `/mls/key-packages/self/:client` (PUT) to replace a client’s key packages in bulk and `/mls/key-packages/claim` (POST) for DS to claim packages when other clients join. Our lighter setup can expose `POST /api/mls/key-packages` for uploads and reserve `claim` for future fan-out.
- **Transport API**: Commit bundles are sent to `/mls/commit-bundles` and application messages to `/mls/messages`. Bundles include TLS-serialised welcome, group info, and optional first message. We need at least `POST /api/mls/commit` and `POST /api/mls/message` with analogous payloads, but we can skip history/propagation complexity initially.
- **Credential provisioning**: Wire’s backend signs credential requests and handles ACME flows (E2E identity). For MVP we keep `CredentialType.Basic` only; no signing service needed yet, but docs reference the eventual flow (ctx.provisionCredentialRequest → backend signing → ctx.completeCredentialProvisioning).
- **State management**: Brig/Galley persist MLS group state: conversation-member mapping, key packages, proposals, commit locks. Our minimal version only needs tables for key packages, commit/message blobs, and perhaps epoch metadata.
- **Removal keys**: They use the helm config to store removal private keys for external remove proposals. Not required for immediate prototype but worth documenting if we add admin removals.
- **Docs location**: `docs/src/understand/mls.md` (in wire-server) summarises the deployment requirements; nothing about client transaction specifics, so we rely on code to infer API shape.

### Proposed Adaptations for Intellacc
1. Add `/api/mls/key-packages` (POST) to accept `{ ciphersuite, credentialType, keyPackages: base64[] }`. Store rows with userId, clientId, ciphersuite, and expiry metadata. Return 204.
2. Add `/api/mls/commit` accepting TLS-serialised commit bundle with optional welcome/message. Persist blob, enqueue socket fan-out to conversation participants.
3. Add `/api/mls/message` accepting application ciphertext payload with epoch + sender client ID; dispatch via Socket.IO.
4. Track `mls_keypackages` table (user_id, client_id, ciphersuite, payload, inserted_at). Consider TTL cleanup job.
5. Start with Basic credentials only; document future step for credential provisioning when backend signer is available.
6. Keep removal key concept as a “future enhancement” (document in wire-messaging.md) but don’t implement yet.
7. Manual smoke test script (`backend/scripts/smokeMls.js`) hits `/api/mls/key-packages`, `/api/mls/commit`, `/api/mls/message`, and `/api/mls/history-secret`. Provide `--token`, `--conversation`, and `--client`.

### Next Milestone Checklist (WIP)
1. Backend decrypt pipeline & credential provisioning
   - add credential provisioning endpoints (`/api/mls/credentials/request` / `/api/mls/credentials/complete`)
   - expose MLS conversation lifecycle (`create`, `addMembers`, `removeMembers`, `commitPendingProposals`)
   - decide on server decrypt vs client decrypt: if server-side, wire core-crypto in backend to produce plaintext for GET `/api/mls/messages`; otherwise pass ciphertext + metadata to frontend for ctx.decryptMessage
   - persist `GroupInfoBundle.payload` for rejoin and record ack metadata (epoch, sender client id)
2. Frontend MLS send/receive integration
   - wrap send path with `ctx.encryptMessage` (store ciphertext) and fetch path with `ctx.decryptMessage`
   - integrate with new decrypt/get APIs, replace stale-flag placeholder, surface epoch/sender in store
3. Tests & tooling
   - extend `backend/scripts/smokeMls.js` or add Jest tests for credential/decrypt endpoints
   - add Vitest coverage around MLS store/service once decrypt is wired

