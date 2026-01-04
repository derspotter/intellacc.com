# Security Architecture: Verified Two-Factor Sync (V8)

This document describes the cryptographic architecture used for end-to-end encrypted messaging and data storage in the application.

## Core Concepts

The architecture is a hybrid of **Signal's Device-Bound Security** and **Password Managers' User-Bound Sync**, enhanced with **Verified Sync** for strict access control.

1.  **Split-Key Encryption:** Local data is encrypted using a Composite Key derived from two secrets:
    *   **Master Key (MK):** A user-level key synced via the server.
    *   **Local Key (LK):** A device-level key that never leaves the device.
    *   `CompositeKey = HKDF(MasterKey, LocalKey)`
2.  **Verified Sync:** The server acts as a gatekeeper for the Master Key. It refuses to release the encrypted Master Key to "stale" or "unknown" devices until they are explicitly verified (e.g., via QR Code from a trusted device).
3.  **Privacy-Preserving Storage:** Local vaults are stored using random UUIDs as keys ("Scan and Unlock"), preventing local attackers from enumerating which user IDs have logged in.

## Key Hierarchy

| Key | Scope | Storage Location | Protection / Wrapping |
| :--- | :--- | :--- | :--- |
| **Password** | User | Memory Only | Never stored. Hashed for auth. |
| **Passkey (PRF)** | User | Hardware / Memory | Never stored. Output used as key. |
| **Master Key (MK)** | Account | Server (Encrypted) | Wrapped by `Hash(Password)` AND `PRF_Output`. |
| **Local Key (LK)** | Device | IndexedDB (Encrypted) | Wrapped by `Hash(Password)` AND `PRF_Output`. |
| **Composite Key** | Session | Memory Only | `HKDF(MK, LK)`. |
| **Vault Data** | Device | IndexedDB | Encrypted with `CompositeKey` (AES-GCM). |

## Workflows

### 1. Registration / First Login
1.  **Generate Keys:** Client generates random `MasterKey` and `LocalKey`.
2.  **Wrap Keys:**
    *   `MK` is wrapped with `Password` -> Uploaded to Server.
    *   `LK` is wrapped with `Password` -> Stored in Local Metadata.
3.  **Encrypt Data:** `CompositeKey` encrypts the initial state.
4.  **Register Device:** Device ID is registered on the server.

### 2. Standard Login (Password)
1.  **Authenticate:** User logs in. Server validates password hash.
2.  **Fetch MK:** Client requests `WrappedMK` from server.
    *   *Check:* Server verifies `device.last_verified_at > key.updated_at`. If OK, returns key.
3.  **Unwrap MK:** Client unwraps `WrappedMK` using `Password`.
4.  **Scan & Unlock:** Client iterates local vaults:
    *   Unwraps `LocalKey` using `Password`.
    *   Derives `CompositeKey`.
    *   Attempts decryption. Success = ownership proof.

### 3. Standard Login (Passkey)
1.  **Authenticate:** User logs in via WebAuthn. Client receives `PRF_Output`.
2.  **Fetch MK:** Server returns `WrappedMK_PRF`.
3.  **Unwrap MK:** Client unwraps `WrappedMK` using `PRF_Output`.
4.  **Scan & Unlock:** Client iterates local vaults:
    *   Unwraps `LocalKey` using `PRF_Output` (stored in `deviceKeyWrapped.prf`).
    *   Derives `CompositeKey`.
    *   Attempts decryption.

### 4. Password Change & Migration
1.  **Change Password (Device A):**
    *   User enters `OldPass` + `NewPass`.
    *   Client re-wraps `MasterKey` with `NewPass` -> Updates Server.
    *   Client re-wraps `LocalKey` with `NewPass` -> Updates Local.
2.  **Login (Device B - Stale):**
    *   User logs in with `NewPass`.
    *   **Server Block:** Server sees Device B is stale (key updated since last verify). Returns `403 LINK_REQUIRED`.
    *   **Link:** User scans QR on Device B using Device A. Server updates Device B `last_verified_at`.
    *   **Fetch MK:** Device B fetches `WrappedMK` (wrapped with `NewPass`). Unwraps successfully.
    *   **Unlock Fail:** Device B tries to unwrap `LocalKey` with `NewPass`. **Fails** (it is wrapped with `OldPass`).
    *   **Migration Prompt:** UI asks for "Old Password".
    *   **Recover:** Client unwraps `LocalKey` using `OldPass`.
    *   **Re-Wrap:** Client re-wraps `LocalKey` with `NewPass`.
    *   **Success:** Vault opens.

## Implementation Map

### Frontend

| Component | File | Description |
| :--- | :--- | :--- |
| **Vault Service** | [`frontend/src/services/vaultService.js`](frontend/src/services/vaultService.js) | Core crypto logic. Handles `setup`, `unlock`, `persistMessage`. |
| - `setupKeystore` | `vaultService.js` | Generates MK/LK, wraps them, and initializes DB. |
| - `findAndUnlock` | `vaultService.js` | Implements "Scan and Unlock" logic. |
| - `persistMessage` | `vaultService.js` | Encrypts messages with `CompositeKey` for local history. |
| **Auth Service** | [`frontend/src/services/auth.js`](frontend/src/services/auth.js) | Orchestrates login flow. Handles "Unlock vs Setup" decision. |
| - `onLoginSuccess` | `auth.js` | Main bootstrapper. Handles auto-unlock and syncing. |
| **Passkey Button** | [`frontend/src/components/auth/PasskeyButton.js`](frontend/src/components/auth/PasskeyButton.js) | Handles PRF-based login and unlock. |
| **Migration Modal** | [`frontend/src/components/vault/MigrationModal.js`](frontend/src/components/vault/MigrationModal.js) | UI for the "Enter Old Password" recovery flow. |

### Backend

| Component | File | Description |
| :--- | :--- | :--- |
| **User Controller** | [`backend/src/controllers/userController.js`](backend/src/controllers/userController.js) | Handles Master Key storage and retrieval. |
| - `setMasterKey` | `userController.js` | Updates key wrappers and `updated_at`. |
| - `getMasterKey` | `userController.js` | Enforces `last_verified_at` access control. |
| **Device Controller** | [`backend/src/controllers/deviceController.js`](backend/src/controllers/deviceController.js) | Handles device registration and linking. |
| - `approveLinking` | `deviceController.js` | Updates `last_verified_at` to trust a device. |

## Data Structures

### Local Storage (IndexedDB: `intellacc_keystore`)
*   **Store:** `device_keystore`
*   **Key:** Random UUID (Privacy).
*   **Value:**
    ```javascript
    {
      id: "uuid...",
      version: 2,
      deviceKeyWrapped: {
        password: { salt, iv, ciphertext }, // Encrypted LocalKey
        prf: { salt, iv, ciphertext }       // Encrypted LocalKey (Optional)
      },
      encryptedDeviceState: { iv, ciphertext } // MLS State encrypted with CompositeKey
    }
    ```

### Server Storage (Postgres)
*   **Table:** `user_master_keys`
    ```sql
    user_id (PK),
    wrapped_key, salt, iv,          -- Encrypted MK (Password)
    wrapped_key_prf, salt_prf, iv_prf, -- Encrypted MK (PRF)
    updated_at
    ```
*   **Table:** `user_devices`
    ```sql
    device_public_id,
    last_verified_at -- Access Control
    ```

## Implementation Notes (Jan 2026)

- `vaultService.saveCurrentState()` now encrypts `exportStateForVault()` output with the Composite Key and updates `encryptedDeviceState` in `intellacc_keystore`.
- `checkVaultExists()` and `hasLockedVaults()` only look for local keystore records (no user identifier is readable without unlock), matching the “Scan and Unlock” privacy model.
- Socket.IO initialization is deferred until a JWT is available, and the token is attached on connect/reconnect to avoid unauthenticated socket attempts.
