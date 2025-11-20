# SOTA E2EE OpenMLS Implementation Plan

This plan outlines the steps to implement State-of-the-Art End-to-End Encryption using the OpenMLS protocol (Messaging Layer Security, RFC 9420) in the Intellacc platform.

## 1. Architecture Overview

The implementation will replace the planned Signal Protocol (Double Ratchet/X3DH) tables with MLS-specific structures. MLS provides better scalability for group chats and stronger security properties (Post-Compromise Security) with efficient key rotation.

To achieve SOTA status (competing with Signal/Wire), we will implement four pillars:
1.  **Perfect Forward Secrecy (PFS)**: Via OpenMLS Ratchet.
2.  **Post-Compromise Security (PCS)**: Via OpenMLS Update/Commit mechanism.
3.  **Authentication (Trust Layer)**: "Safety Numbers" to prevent MITM.
4.  **Endpoint Security (Storage Layer)**: "Encryption at Rest" using Argon2id-derived keys.

### Components
- **Frontend (WASM)**: `openmls-wasm` crate wrapping the Rust `openmls` library. Handles all cryptographic operations (Key Package generation, Group state management, Encryption/Decryption) and **Argon2id key derivation**.
- **Frontend (JS)**: `CoreCryptoClient` manages the WASM lifecycle, Encrypted IndexedDB persistence, and API communication.
- **Backend**: Acts as the **Delivery Service (DS)** and **Authentication Service (AS)**. Stores Key Packages and forwards encrypted messages (Welcome, Commit, Application). Enforces strict message ordering.
- **Database**: Stores Key Packages and queued messages.

## 2. Database Schema Updates

The current migration `20250908_add_e2ee_signal_tables.sql` is designed for the Signal Protocol. We will replace/augment it for MLS.

**New Tables:**
1.  `mls_key_packages`: Stores public Key Packages for users.
    - `user_id` (FK)
    - `device_id` (Text)
    - `key_package_data` (Bytea/Text - The serialized KeyPackage)
    - `hash` (Text - Unique identifier for the package)
    - `created_at`
2.  `mls_groups`: Tracks group metadata (optional, but good for the backend to know who is in what group for routing).
    - `group_id` (Text - The MLS Group ID)
    - `created_by` (FK)
3.  `mls_group_members`: Maps users to groups.
    - `group_id` (FK)
    - `user_id` (FK)
4.  `mls_messages`: Stores encrypted messages for offline delivery.
    - `id` (Serial/BigSerial) - **Strictly ordered**.
    - `group_id` (Text)
    - `sender_id` (FK)
    - `content_type` (Enum: 'application', 'proposal', 'commit', 'welcome')
    - `data` (Bytea/Text - The encrypted MLSMessage)
    - `epoch` (Int - To order messages)

## 3. Rust/WASM Extension (`openmls-wasm`)

The current `openmls-wasm` crate needs to be expanded to support the full MLS lifecycle and SOTA security features.

**Required Functions:**
- **Core MLS**:
    - `create_group(group_id: &[u8]) -> Vec<u8>`
    - `add_member(group_id: &[u8], key_package_bytes: &[u8]) -> (Vec<u8>, Vec<u8>)`
    - `process_welcome(welcome_bytes: &[u8], ratchet_tree: Option<&[u8]>) -> Vec<u8>`
    - `process_commit(group_id: &[u8], commit_bytes: &[u8]) -> Result`
    - `encrypt_message(group_id: &[u8], message: &[u8]) -> Vec<u8>`
    - `decrypt_message(group_id: &[u8], ciphertext: &[u8]) -> Vec<u8>`
    - `export_group_state(group_id: &[u8]) -> Vec<u8>`
    - `import_group_state(state_bytes: &[u8]) -> Result`
- **Trust Layer**:
    - `get_identity_fingerprint() -> String`: Returns SHA-256 hex digest of the identity key for "Safety Number" verification.
- **Storage Layer**:
    - `derive_key_argon2id(password: &str, salt: &[u8]) -> Vec<u8>`: Derives a MasterKey for local storage encryption.

## 4. Backend Implementation

**API Routes (`backend/src/routes/mls.js`):**
- `POST /key-package`: Upload a Key Package.
- `GET /key-package/:userId`: Fetch a Key Package to add a user to a group.
- `POST /messages/welcome`: Send a Welcome message to a new member.
- `POST /messages/group`: Send a Commit or Application message to a group.
    - **Critical**: Must use database locking or serial processing to ensure messages are stored in strict order per group.
- `GET /messages/:groupId`: Fetch new messages.

**Socket Events:**
- `mls-message`: Real-time delivery of MLS messages.
- `mls-welcome`: Real-time delivery of Welcome messages.

## 5. Frontend Integration

**`CoreCryptoClient` Updates:**
- **Storage Layer ("The Vault")**:
    - On Login: Prompt for password (or separate encryption PIN).
    - Call WASM `derive_key_argon2id`.
    - Use `crypto.subtle.encrypt` (AES-GCM) to save WASM state to IndexedDB.
    - Never store keys in plain text.
    - "Panic Button": Ability to wipe the encryption key/IndexedDB.
- **Trust Layer**:
    - Expose `getFingerprint()` method.
    - UI: "Verify Session" modal showing the fingerprint.
    - Store `is_verified` status for contacts.
- **Group Management**:
    - Implement `createGroup`, `handleIncomingMessage` as previously planned.

## 6. Implementation Steps

1.  **Database**: Create a new migration file for MLS tables (Done).
2.  **WASM**: Update `openmls-wasm/src/lib.rs` and `Cargo.toml` to add `argon2` and missing MLS functions.
3.  **Backend**: Create `mlsService.js` and routes with strict ordering logic.
4.  **Frontend**: Update `CoreCryptoClient.js` to implement the "Vault" (Encrypted Storage) and "Trust" (Fingerprints).
5.  **UI**: Build Chat Interface and Verification Modal.

## Immediate Next Step
I will proceed with **Step 2: Extending the `openmls-wasm` crate** to support the required cryptographic operations and Argon2id.
