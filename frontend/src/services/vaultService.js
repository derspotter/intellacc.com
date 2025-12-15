// frontend/src/services/vaultService.js
// Vault service for encrypted storage at rest using Argon2id + AES-256-GCM

import init, { MlsClient } from 'openmls-wasm';
import crypto from './crypto.js';

let wasmInitialized = false;
import vaultStore from '../stores/vaultStore.js';
import coreCryptoClient from './mls/coreCryptoClient.js';
import { initIdleAutoLock, stopIdleAutoLock, loadIdleLockConfig } from './idleLock.js';

const VAULT_DB_NAME = 'intellacc_vault';
const VAULT_DB_VERSION = 1;
const VAULT_STORE_NAME = 'vault_data';

class VaultService {
    constructor() {
        this.db = null;
        this.aesKey = null; // In-memory AES key (wiped on lock)
    }

    /**
     * Initialize the vault IndexedDB
     */
    async initDB() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
                    db.createObjectStore(VAULT_STORE_NAME, { keyPath: 'id' });
                }
            };
        });
    }

    /**
     * Derive AES-256 key from passphrase using Argon2id (via WASM)
     * @param {string} passphrase - User's passphrase
     * @param {Uint8Array} salt - 32-byte random salt
     * @returns {Promise<CryptoKey>} AES-GCM key for Web Crypto API
     */
    async deriveKey(passphrase, salt) {
        // Ensure WASM is initialized
        if (!wasmInitialized) {
            await init();
            wasmInitialized = true;
        }

        // Use WASM Argon2id to derive 32 bytes (static method on MlsClient)
        const keyBytes = MlsClient.derive_key_argon2id(passphrase, salt);

        // Import into Web Crypto API as AES-GCM key
        const aesKey = await window.crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM', length: 256 },
            false, // not extractable
            ['encrypt', 'decrypt']
        );

        return aesKey;
    }

    /**
     * Check if a vault exists for the given user
     * @param {string|number} userId - User ID
     * @returns {Promise<boolean>}
     */
    async checkVaultExists(userId) {
        await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([VAULT_STORE_NAME], 'readonly');
            const store = transaction.objectStore(VAULT_STORE_NAME);
            const request = store.get(`vault_${userId}`);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const exists = !!request.result;
                vaultStore.setVaultExists(exists);
                resolve(exists);
            };
        });
    }

    /**
     * Set up a new vault for the user (first-time setup)
     * @param {string} passphrase - User's chosen passphrase
     * @returns {Promise<void>}
     */
    async setupVault(passphrase) {
        const userId = vaultStore.userId;
        if (!userId) throw new Error('No user ID set');

        await this.initDB();

        // Generate random salt (32 bytes for Argon2id)
        const salt = window.crypto.getRandomValues(new Uint8Array(32));

        // Derive key from passphrase
        const aesKey = await this.deriveKey(passphrase, salt);
        this.aesKey = aesKey;

        // Export MLS state from coreCryptoClient
        const mlsState = await coreCryptoClient.exportStateForVault();
        if (!mlsState) {
            throw new Error('No MLS state to encrypt');
        }

        // Serialize state to JSON
        const stateJson = JSON.stringify(mlsState);

        // Generate IV for AES-GCM (12 bytes)
        const iv = window.crypto.getRandomValues(new Uint8Array(12));

        // Encrypt state
        const encoder = new TextEncoder();
        const plainBytes = encoder.encode(stateJson);
        const cipherBuffer = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            plainBytes
        );
        const encryptedState = new Uint8Array(cipherBuffer);

        // Store in IndexedDB
        const vaultRecord = {
            id: `vault_${userId}`,
            salt: Array.from(salt),           // Store as array for JSON compat
            iv: Array.from(iv),
            encryptedState: Array.from(encryptedState),
            createdAt: Date.now(),
            version: 1
        };

        await new Promise((resolve, reject) => {
            const transaction = this.db.transaction([VAULT_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(VAULT_STORE_NAME);
            const request = store.put(vaultRecord);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });

        // Update store state
        vaultStore.setVaultExists(true);
        vaultStore.setLocked(false);
        vaultStore.setShowSetupModal(false);
        vaultStore.updateActivity();

        // Start idle auto-lock
        loadIdleLockConfig();
        initIdleAutoLock();

        console.log('[Vault] Setup complete for user:', userId);
    }

    /**
     * Unlock the vault with passphrase
     * @param {string} passphrase - User's passphrase
     * @returns {Promise<void>}
     */
    async unlock(passphrase) {
        const userId = vaultStore.userId;
        if (!userId) throw new Error('No user ID set');

        await this.initDB();

        // Load vault record
        const vaultRecord = await new Promise((resolve, reject) => {
            const transaction = this.db.transaction([VAULT_STORE_NAME], 'readonly');
            const store = transaction.objectStore(VAULT_STORE_NAME);
            const request = store.get(`vault_${userId}`);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        if (!vaultRecord) {
            throw new Error('No vault found for this user');
        }

        // Restore arrays to Uint8Array
        const salt = new Uint8Array(vaultRecord.salt);
        const iv = new Uint8Array(vaultRecord.iv);
        const encryptedState = new Uint8Array(vaultRecord.encryptedState);

        // Derive key from passphrase
        const aesKey = await this.deriveKey(passphrase, salt);

        // Attempt decryption
        let plainBytes;
        try {
            const plainBuffer = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                aesKey,
                encryptedState
            );
            plainBytes = new Uint8Array(plainBuffer);
        } catch (err) {
            console.error('[Vault] Decryption failed:', err);
            throw new Error('Wrong passphrase');
        }

        // Parse state
        const decoder = new TextDecoder();
        const stateJson = decoder.decode(plainBytes);
        const mlsState = JSON.parse(stateJson);

        // Restore MLS state
        await coreCryptoClient.restoreStateFromVault(mlsState);

        // Keep key in memory for re-encryption on changes
        this.aesKey = aesKey;

        // Update store state
        vaultStore.setLocked(false);
        vaultStore.setShowUnlockModal(false);
        vaultStore.updateActivity();

        // Start idle auto-lock
        loadIdleLockConfig();
        initIdleAutoLock();

        console.log('[Vault] Unlocked for user:', userId);
    }

    /**
     * Lock the vault (wipe keys from memory)
     */
    async lockKeys() {
        // Stop idle auto-lock
        stopIdleAutoLock();

        // Wipe coreCryptoClient memory
        coreCryptoClient.wipeMemory();

        // Wipe local AES key
        this.aesKey = null;

        // Update store state
        vaultStore.setLocked(true);

        console.log('[Vault] Locked');
    }

    /**
     * Save current MLS state to vault (call after state changes)
     */
    async saveCurrentState() {
        if (vaultStore.isLocked || !this.aesKey) {
            console.warn('[Vault] Cannot save state while locked');
            return;
        }

        const userId = vaultStore.userId;
        if (!userId) return;

        await this.initDB();

        // Load existing vault record for salt
        const vaultRecord = await new Promise((resolve, reject) => {
            const transaction = this.db.transaction([VAULT_STORE_NAME], 'readonly');
            const store = transaction.objectStore(VAULT_STORE_NAME);
            const request = store.get(`vault_${userId}`);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        if (!vaultRecord) return;

        // Export current MLS state
        const mlsState = await coreCryptoClient.exportStateForVault();
        if (!mlsState) return;

        // Serialize and encrypt
        const stateJson = JSON.stringify(mlsState);
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encoder = new TextEncoder();
        const plainBytes = encoder.encode(stateJson);
        const cipherBuffer = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.aesKey,
            plainBytes
        );
        const encryptedState = new Uint8Array(cipherBuffer);

        // Update vault record
        const updatedRecord = {
            ...vaultRecord,
            iv: Array.from(iv),
            encryptedState: Array.from(encryptedState),
            updatedAt: Date.now()
        };

        await new Promise((resolve, reject) => {
            const transaction = this.db.transaction([VAULT_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(VAULT_STORE_NAME);
            const request = store.put(updatedRecord);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });

        console.log('[Vault] State saved');
    }

    /**
     * Panic wipe - delete all vault data and logout
     */
    async panicWipe() {
        const userId = vaultStore.userId;

        // Wipe memory first
        coreCryptoClient.wipeMemory();
        this.aesKey = null;

        // Delete vault from IndexedDB
        if (userId) {
            await this.initDB();
            await new Promise((resolve, reject) => {
                const transaction = this.db.transaction([VAULT_STORE_NAME], 'readwrite');
                const store = transaction.objectStore(VAULT_STORE_NAME);
                const request = store.delete(`vault_${userId}`);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        }

        // Also clear openmls_storage IndexedDB
        try {
            await coreCryptoClient.clearState();
        } catch (e) {
            console.warn('[Vault] Error clearing MLS state:', e);
        }

        // Reset vault store
        vaultStore.reset();

        console.log('[Vault] Panic wipe complete');
    }

    /**
     * Change the vault passphrase
     * @param {string} currentPassphrase - Current passphrase
     * @param {string} newPassphrase - New passphrase
     */
    async changePassphrase(currentPassphrase, newPassphrase) {
        const userId = vaultStore.userId;
        if (!userId) throw new Error('No user ID set');

        // First unlock with current passphrase to verify it
        await this.unlock(currentPassphrase);

        // Generate new salt
        const newSalt = window.crypto.getRandomValues(new Uint8Array(32));

        // Derive new key
        const newAesKey = await this.deriveKey(newPassphrase, newSalt);

        // Export current state
        const mlsState = await coreCryptoClient.exportStateForVault();
        if (!mlsState) throw new Error('No MLS state');

        // Encrypt with new key
        const stateJson = JSON.stringify(mlsState);
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encoder = new TextEncoder();
        const plainBytes = encoder.encode(stateJson);
        const cipherBuffer = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            newAesKey,
            plainBytes
        );
        const encryptedState = new Uint8Array(cipherBuffer);

        // Update vault record
        const vaultRecord = {
            id: `vault_${userId}`,
            salt: Array.from(newSalt),
            iv: Array.from(iv),
            encryptedState: Array.from(encryptedState),
            createdAt: Date.now(),
            version: 1
        };

        await this.initDB();
        await new Promise((resolve, reject) => {
            const transaction = this.db.transaction([VAULT_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(VAULT_STORE_NAME);
            const request = store.put(vaultRecord);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });

        // Update in-memory key
        this.aesKey = newAesKey;

        console.log('[Vault] Passphrase changed');
    }
}

export default new VaultService();
