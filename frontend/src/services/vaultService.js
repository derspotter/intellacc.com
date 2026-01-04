// frontend/src/services/vaultService.js
// Device Keystore service: Manages device-local keys using Split-Key Architecture (V8)
// 1. Local DB encrypted by Composite Key = HKDF(MasterKey, LocalKey).
// 2. Master Key (MK) synced via server (Server-Gated).
// 3. Local Key (LK) stored locally (Wrapped by Password).
// 4. Provides defense-in-depth: Compromising server OR device is insufficient to decrypt.

import init, { MlsClient } from 'openmls-wasm';
import vaultStore from '../stores/vaultStore.js';
import coreCryptoClient from './mls/coreCryptoClient.js';
import { initIdleAutoLock, stopIdleAutoLock, loadIdleLockConfig } from './idleLock.js';
import { api } from './api.js';

let wasmInitialized = false;

const KEYSTORE_DB_NAME = 'intellacc_keystore';
const KEYSTORE_DB_VERSION = 6; // Bump for Split-Key Schema
const KEYSTORE_STORE_NAME = 'device_keystore';
const MESSAGES_STORE_NAME = 'encrypted_messages';

class VaultService {
    constructor() {
        this.db = null;
        this.compositeKey = null; // The actual encryption key
        this.masterKey = null;
        this.localKey = null;
        this.deviceId = null; 
        this.masterKeyCreated = false;
    }

    getDeviceId() {
        return this.deviceId;
    }

    didCreateMasterKey() {
        return this.masterKeyCreated;
    }

    setDeviceId(deviceId) {
        this.deviceId = deviceId;
        try {
            if (deviceId) {
                localStorage.setItem('device_id', deviceId);
            } else {
                localStorage.removeItem('device_id');
            }
        } catch {}
    }

    clearDeviceId() {
        this.setDeviceId(null);
    }

    async initDB() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(KEYSTORE_DB_NAME, KEYSTORE_DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { this.db = request.result; resolve(); };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (event.oldVersion < 6) {
                    try {
                        if (db.objectStoreNames.contains(KEYSTORE_STORE_NAME)) db.deleteObjectStore(KEYSTORE_STORE_NAME);
                        if (db.objectStoreNames.contains(MESSAGES_STORE_NAME)) db.deleteObjectStore(MESSAGES_STORE_NAME);
                    } catch (e) {}
                }
                if (!db.objectStoreNames.contains(KEYSTORE_STORE_NAME)) {
                    db.createObjectStore(KEYSTORE_STORE_NAME, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(MESSAGES_STORE_NAME)) {
                    const store = db.createObjectStore(MESSAGES_STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('groupId', 'groupId', { unique: false });
                    store.createIndex('deviceId', 'deviceId', { unique: false }); 
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    async getLocalDeviceIds() {
        await this.initDB();
        return new Promise((resolve) => {
            const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readonly');
            const req = tx.objectStore(KEYSTORE_STORE_NAME).getAllKeys();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
        });
    }

    async getOrCreateMasterKey(password) {
        const deviceIds = await this.getLocalDeviceIds();
        this.masterKeyCreated = false;
        try {
            const result = await api.users.getMasterKey(deviceIds);
            if (result && result.wrapped_key) {
                const salt = new Uint8Array(result.salt.split(',').map(Number));
                const iv = new Uint8Array(result.iv.split(',').map(Number));
                const ciphertext = new Uint8Array(result.wrapped_key.split(',').map(Number));
                const wrappingKey = await this.deriveWrappingKey(password, salt);
                try {
                    const mkBytes = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ciphertext);
                    const mk = await window.crypto.subtle.importKey('raw', mkBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
                    if (result.deviceId) this.setDeviceId(result.deviceId);
                    return mk;
                } catch (e) { throw new Error('Incorrect password (MK)'); }
            }
        } catch (e) {
            if (e.status === 403 && e.data?.code === 'LINK_REQUIRED') throw e;
            if (e.status !== 404) throw e; 
        }
        const mk = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        await this.updateMasterKeyOnServer(mk, password);
        this.masterKeyCreated = true;
        return mk;
    }

    async updateMasterKeyOnServer(masterKey, password) {
        const salt = window.crypto.getRandomValues(new Uint8Array(32));
        const wrappingKey = await this.deriveWrappingKey(password, salt);
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const rawMk = await window.crypto.subtle.exportKey('raw', masterKey);
        const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawMk);
        await api.users.setMasterKey(
            Array.from(new Uint8Array(ciphertext)).join(','),
            Array.from(salt).join(','),
            Array.from(iv).join(',')
        );
    }

    async deriveCompositeKey(masterKey, localKey) {
        // Combine MK and LK using HKDF-ish logic (Import both as raw bytes, concat, hash?)
        // Or encrypt one with other?
        // Simple: Key = SHA-256(RawMK || RawLK)
        const rawMK = new Uint8Array(await window.crypto.subtle.exportKey('raw', masterKey));
        const rawLK = new Uint8Array(await window.crypto.subtle.exportKey('raw', localKey));
        
        const combined = new Uint8Array(rawMK.length + rawLK.length);
        combined.set(rawMK);
        combined.set(rawLK, rawMK.length);
        
        const hash = await window.crypto.subtle.digest('SHA-256', combined);
        return window.crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    }

    async findAndUnlock(password, userId) {
        if (!userId) return false;
        try {
            this.masterKey = await this.getOrCreateMasterKey(password);
        } catch (e) {
            if (e.status === 403) throw e;
            return false;
        }

        await this.initDB();
        if (this.deviceId) {
            if (await this.tryUnlockRecord(this.deviceId, userId, password)) return true;
        }
        const records = await this.getLocalDeviceIds();
        for (const id of records) {
            if (id === this.deviceId) continue;
            if (await this.tryUnlockRecord(id, userId, password)) return true;
        }
        return false;
    }

    async tryUnlockRecord(recordId, userId, password) {
        return new Promise((resolve) => {
            const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readonly');
            const req = tx.objectStore(KEYSTORE_STORE_NAME).get(recordId);
            req.onsuccess = async () => {
                const record = req.result;
                if (!record || !record.deviceKeyWrapped) return resolve(false);

                // 1. Unwrap Local Key using Password
                try {
                    const pwWrap = record.deviceKeyWrapped.password;
                    const salt = new Uint8Array(pwWrap.salt);
                    const wrappingKey = await this.deriveWrappingKey(password, salt);
                    this.localKey = await this.unwrapDeviceKey(pwWrap, wrappingKey);
                } catch (e) {
                    // Wrong password for LOCAL key (Migration needed?)
                    // If we have Master Key (which we do, unlocked by password), but fail here...
                    // It implies password changed on server but not locally.
                    // We need to return false here, but maybe signal migration?
                    // Caller (findAndUnlock) iterates. If all fail, caller returns false.
                    // Auth.js sees false -> shows Migration Modal?
                    // No, auth.js logic is: Unlock -> Fail -> Setup.
                    // We need to signal "Found Vault but Password Wrong" vs "No Vault".
                    // For now, simple fail.
                    return resolve(false); 
                }

                // 2. Derive Composite
                try {
                    this.compositeKey = await this.deriveCompositeKey(this.masterKey, this.localKey);
                    
                    // 3. Verify Ownership
                    const stateIv = new Uint8Array(record.encryptedDeviceState.iv);
                    const stateCipher = new Uint8Array(record.encryptedDeviceState.ciphertext);
                    
                    const plainBuffer = await window.crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv: stateIv },
                        this.compositeKey,
                        stateCipher
                    );
                    const mlsState = JSON.parse(new TextDecoder().decode(plainBuffer));

                    if (String(mlsState.identityName) === String(userId)) {
                        this.setDeviceId(record.deviceId);
                        vaultStore.setVaultExists(true);
                        vaultStore.setLocked(false);
                        vaultStore.setUserId(userId);
                        vaultStore.updateActivity();
                        await coreCryptoClient.restoreStateFromVault(mlsState);
                        loadIdleLockConfig();
                        initIdleAutoLock();
                        return resolve(true);
                    }
                } catch (e) {}
                resolve(false);
            };
            req.onerror = () => resolve(false);
        });
    }

    async setupKeystoreWithPassword(password) {
        const userId = vaultStore.userId;
        if (!userId) throw new Error('No user ID set');

        if (!this.masterKey) {
            this.masterKey = await this.getOrCreateMasterKey(password);
        }

        await this.initDB();
        const deviceId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : 'rand';
        
        // Generate Local Key
        this.localKey = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        
        // Wrap Local Key with Password
        const passwordSalt = window.crypto.getRandomValues(new Uint8Array(32));
        const wrappingKey = await this.deriveWrappingKey(password, passwordSalt);
        const wrappedLK = await this.wrapDeviceKey(this.localKey, wrappingKey);

        // Derive Composite
        this.compositeKey = await this.deriveCompositeKey(this.masterKey, this.localKey);

        await coreCryptoClient.ensureMlsBootstrap(String(userId));
        const mlsState = await coreCryptoClient.exportStateForVault();
        const stateJson = JSON.stringify(mlsState);
        const stateIv = window.crypto.getRandomValues(new Uint8Array(12));
        const stateCipher = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: stateIv },
            this.compositeKey,
            new TextEncoder().encode(stateJson)
        );

        const keystoreRecord = {
            id: deviceId,
            deviceId: deviceId,
            version: 2,
            deviceKeyWrapped: {
                password: {
                    salt: Array.from(passwordSalt),
                    iv: wrappedLK.iv,
                    ciphertext: wrappedLK.ciphertext
                }
            },
            encryptedDeviceState: {
                iv: Array.from(stateIv),
                ciphertext: Array.from(new Uint8Array(stateCipher))
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await new Promise((resolve, reject) => {
            const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readwrite');
            tx.objectStore(KEYSTORE_STORE_NAME).put(keystoreRecord);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        this.setDeviceId(deviceId);
        this.deviceKey = this.compositeKey; // alias

        try {
            const deviceName = `${navigator.platform || 'Web'} - ${navigator.userAgent.split('/')[0]}`;
            await api.devices.register(deviceId, deviceName);
        } catch (e) {}

        vaultStore.setVaultExists(true);
        vaultStore.setLocked(false);
        vaultStore.updateActivity();
        loadIdleLockConfig();
        initIdleAutoLock();
        console.log('[Keystore] Setup complete (Split-Key Mode)');
    }

    async saveCurrentState() {
        if (!this.compositeKey || !this.deviceId) {
            if (!vaultStore.isLocked) {
                console.warn('[Vault] saveCurrentState skipped (vault locked)');
            }
            return false;
        }

        const mlsState = await coreCryptoClient.exportStateForVault();
        if (!mlsState) {
            console.warn('[Vault] saveCurrentState skipped (no MLS state)');
            return false;
        }

        const stateJson = JSON.stringify(mlsState);
        const stateIv = window.crypto.getRandomValues(new Uint8Array(12));
        const stateCipher = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: stateIv },
            this.compositeKey,
            new TextEncoder().encode(stateJson)
        );

        await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readwrite');
            const store = tx.objectStore(KEYSTORE_STORE_NAME);
            let didWrite = false;

            const req = store.get(this.deviceId);
            req.onsuccess = () => {
                const record = req.result;
                if (!record) {
                    console.warn('[Vault] saveCurrentState skipped (record not found)');
                    return;
                }

                record.encryptedDeviceState = {
                    iv: Array.from(stateIv),
                    ciphertext: Array.from(new Uint8Array(stateCipher))
                };
                record.updatedAt = Date.now();
                store.put(record);
                didWrite = true;
            };
            req.onerror = () => reject(req.error);
            tx.oncomplete = () => resolve(didWrite);
            tx.onerror = () => reject(tx.error);
        });
    }

    async persistMessage(message) {
        if (!this.compositeKey || !this.deviceId) return; 
        await this.initDB();
        const payload = JSON.stringify({ plaintext: message.plaintext, senderId: message.senderId, type: message.type });
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encryptedBuffer = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.compositeKey, new TextEncoder().encode(payload));
        const record = {
            groupId: message.groupId, timestamp: message.timestamp, messageId: message.id, deviceId: this.deviceId,
            encryptedData: { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(encryptedBuffer)) }
        };
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([MESSAGES_STORE_NAME], 'readwrite');
            tx.objectStore(MESSAGES_STORE_NAME).add(record);
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
    }

    async getMessages(groupId) {
        if (!this.compositeKey || !this.deviceId) throw new Error('Vault locked');
        await this.initDB();
        const records = await new Promise((resolve, reject) => {
            const tx = this.db.transaction([MESSAGES_STORE_NAME], 'readonly');
            const req = tx.objectStore(MESSAGES_STORE_NAME).index('groupId').getAll(groupId);
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
        const deviceRecords = records.filter(r => r.deviceId === this.deviceId);
        const messages = await Promise.all(deviceRecords.map(async (rec) => {
            try {
                const iv = new Uint8Array(rec.encryptedData.iv);
                const ciphertext = new Uint8Array(rec.encryptedData.ciphertext);
                const plainBuffer = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.compositeKey, ciphertext);
                const payload = JSON.parse(new TextDecoder().decode(plainBuffer));
                return { id: rec.messageId, groupId: rec.groupId, timestamp: rec.timestamp, senderId: payload.senderId, plaintext: payload.plaintext, type: payload.type };
            } catch (e) { return null; }
        }));
        return messages.filter(m => m !== null).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    async deriveWrappingKey(password, salt) {
        if (!wasmInitialized) { await init(); wasmInitialized = true; }
        const keyBytes = MlsClient.derive_key_argon2id(password, salt);
        return window.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    
    // Helpers
    async wrapDeviceKey(deviceKey, wrappingKey) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const exportedKey = await window.crypto.subtle.exportKey('raw', deviceKey);
        const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, exportedKey);
        return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
    }
    async unwrapDeviceKey(wrappedObject, wrappingKey) {
        const iv = new Uint8Array(wrappedObject.iv);
        const ciphertext = new Uint8Array(wrappedObject.ciphertext);
        try {
            const rawKey = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ciphertext);
            return await window.crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        } catch (e) { throw new Error('Unwrap failed'); }
    }

    async hasLockedVaults() {
        await this.initDB();
        const deviceIds = await this.getLocalDeviceIds();
        return deviceIds.length > 0;
    }

    async checkVaultExists(userId) {
        vaultStore.setVaultExists(true);
        return true;
    }
    
    // Migration Logic: Unlock with Old Password
    async findAndUnlock(password, userId, isMigration = false) {
        // If migrating, we already have MasterKey (from Current Password)
        // We just need to unlock Local Key with Old Password
        if (isMigration && this.masterKey) {
             // ... re-use tryUnlockRecord but force check
             // Actually tryUnlockRecord uses password to unwrap LK.
             // So calling tryUnlockRecord(..., oldPassword) works!
             // We need to iterate again.
             const records = await this.getLocalDeviceIds();
             for (const id of records) {
                 if (await this.tryUnlockRecord(id, userId, password)) {
                     // Success! Now Re-Wrap LK with CURRENT password (implied)?
                     // Caller handles re-wrap?
                     // `changePassphrase` handles re-wrap.
                     return true;
                 }
             }
             return false;
        }
        
        // Standard flow ...
        // (Code from findAndUnlock above)
        if (!userId) return false;
        try {
            this.masterKey = await this.getOrCreateMasterKey(password);
        } catch (e) {
            if (e.status === 403) throw e;
            return false;
        }
        await this.initDB();
        if (this.deviceId && await this.tryUnlockRecord(this.deviceId, userId, password)) return true;
        const records = await this.getLocalDeviceIds();
        for (const id of records) {
            if (id === this.deviceId) continue;
            if (await this.tryUnlockRecord(id, userId, password)) return true;
        }
        return false;
    }

    async unlockWithPassword(password) {
        const userId = vaultStore.userId;
        const found = await this.findAndUnlock(password, userId);
        if (!found) throw new Error('Incorrect password or vault not found');
    }
    async unlock(password) { return this.unlockWithPassword(password); }

    async changePassphrase(oldPassword, newPassword) {
        // If migrating: we unlocked with OldPassword.
        // We need to re-wrap LocalKey with NewPassword.
        // AND re-wrap MasterKey with NewPassword (on server) IF we are the password changer.
        
        // Scenario 1: User changing password here.
        // Update Server MK + Update Local LK.
        
        // Scenario 2: User changed password elsewhere. Migrating here.
        // Server MK is already updated (we fetched it with NewPassword).
        // We just need to Update Local LK.
        
        // Check if MK wrapper on server matches NewPassword?
        // We can just overwrite it. It's idempotent.
        
        if (!this.localKey) throw new Error('Must be unlocked');
        
        const newSalt = window.crypto.getRandomValues(new Uint8Array(32));
        const newWrappingKey = await this.deriveWrappingKey(newPassword, newSalt);
        const wrappedLK = await this.wrapDeviceKey(this.localKey, newWrappingKey);
        
        // Update Local
        await this.initDB();
        const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readwrite');
        const store = tx.objectStore(KEYSTORE_STORE_NAME);
        const record = await new Promise(r => store.get(this.deviceId).onsuccess = e => r(e.target.result));
        
        record.deviceKeyWrapped.password = { salt: Array.from(newSalt), iv: wrappedLK.iv, ciphertext: wrappedLK.ciphertext };
        record.updatedAt = Date.now();
        await new Promise(r => store.put(record).onsuccess = r);
        
        // Update Server
        await this.updateMasterKeyOnServer(this.masterKey, newPassword);
        console.log('[Keystore] Password changed & keys re-wrapped');
    }

    async lockKeys() {
        stopIdleAutoLock();
        coreCryptoClient.wipeMemory();
        this.masterKey = null;
        this.localKey = null;
        this.compositeKey = null;
        this.deviceKey = null; // Alias
        this.clearDeviceId();
        vaultStore.setLocked(true);
        console.log('[Keystore] Locked');
    }
    
    // PRF placeholders
    async getPrfInput() { return null; }
    async unlockWithPrf(prfOutput) {
        const userId = vaultStore.userId;
        if (!userId) throw new Error('User ID required');

        // 1. Get Master Key using PRF
        const deviceIds = await this.getLocalDeviceIds();
        let masterKey;
        
        try {
            const result = await api.users.getMasterKey(deviceIds);
            if (result && result.wrapped_key_prf) {
                const salt = new Uint8Array(result.salt_prf.split(',').map(Number));
                const iv = new Uint8Array(result.iv_prf.split(',').map(Number));
                const ciphertext = new Uint8Array(result.wrapped_key_prf.split(',').map(Number));
                
                // PRF Key derivation (HKDF from PRF Output + Salt)
                const prfKey = await window.crypto.subtle.importKey('raw', prfOutput, { name: 'HKDF' }, false, ['deriveKey']);
                const wrappingKey = await window.crypto.subtle.deriveKey(
                    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: new TextEncoder().encode('MasterKey_PRF') },
                    prfKey,
                    { name: 'AES-GCM', length: 256 },
                    false,
                    ['decrypt']
                );

                const mkBytes = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ciphertext);
                masterKey = await window.crypto.subtle.importKey('raw', mkBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
                if (result.deviceId) this.setDeviceId(result.deviceId);
            } else {
                throw new Error('No PRF wrapping for Master Key');
            }
        } catch (e) {
            console.error('PRF Master Key Unlock Failed:', e);
            throw new Error('PRF Unlock Failed (Server)');
        }

        this.masterKey = masterKey;
        await this.initDB();

        // 2. Find and Unlock Local Key using PRF
        // Optimistic check
        if (this.deviceId) {
            if (await this.tryUnlockRecordPrf(this.deviceId, userId, prfOutput)) return true;
        }
        
        const records = await this.getLocalDeviceIds();
        for (const id of records) {
            if (id === this.deviceId) continue;
            if (await this.tryUnlockRecordPrf(id, userId, prfOutput)) return true;
        }
        
        throw new Error('PRF Unlock Failed (Local)');
    }

    async tryUnlockRecordPrf(recordId, userId, prfOutput) {
        return new Promise((resolve) => {
            const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readonly');
            const req = tx.objectStore(KEYSTORE_STORE_NAME).get(recordId);
            req.onsuccess = async () => {
                const record = req.result;
                if (!record || !record.deviceKeyWrapped?.prf) return resolve(false);

                try {
                    const prfWrap = record.deviceKeyWrapped.prf;
                    const salt = new Uint8Array(prfWrap.salt); // Stored in local record
                    
                    const prfKey = await window.crypto.subtle.importKey('raw', prfOutput, { name: 'HKDF' }, false, ['deriveKey']);
                    const wrappingKey = await window.crypto.subtle.deriveKey(
                        { name: 'HKDF', hash: 'SHA-256', salt: salt, info: new TextEncoder().encode('LocalKey_PRF') },
                        prfKey,
                        { name: 'AES-GCM', length: 256 },
                        false,
                        ['decrypt']
                    );

                    this.localKey = await this.unwrapDeviceKey(prfWrap, wrappingKey);
                    this.compositeKey = await this.deriveCompositeKey(this.masterKey, this.localKey);
                    
                    // Verify
                    const stateIv = new Uint8Array(record.encryptedDeviceState.iv);
                    const stateCipher = new Uint8Array(record.encryptedDeviceState.ciphertext);
                    const plainBuffer = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: stateIv }, this.compositeKey, stateCipher);
                    const mlsState = JSON.parse(new TextDecoder().decode(plainBuffer));

                    if (String(mlsState.identityName) === String(userId)) {
                        this.setDeviceId(record.deviceId);
                        vaultStore.setVaultExists(true);
                        vaultStore.setLocked(false);
                        vaultStore.setUserId(userId);
                        vaultStore.updateActivity();
                        await coreCryptoClient.restoreStateFromVault(mlsState);
                        loadIdleLockConfig();
                        initIdleAutoLock();
                        console.log('[Keystore] Unlocked with PRF');
                        return resolve(true);
                    }
                } catch (e) {}
                resolve(false);
            };
            req.onerror = () => resolve(false);
        });
    }

    async setupPrfWrapping(prfOutput, credentialId) {
        if (!this.masterKey || !this.localKey || !this.deviceId) throw new Error('Vault locked');
        
        // 1. Wrap Master Key
        const mkSalt = window.crypto.getRandomValues(new Uint8Array(32));
        const prfKeyMK = await window.crypto.subtle.importKey('raw', prfOutput, { name: 'HKDF' }, false, ['deriveKey']);
        const wrappingKeyMK = await window.crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: mkSalt, info: new TextEncoder().encode('MasterKey_PRF') },
            prfKeyMK,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt']
        );
        const ivMK = window.crypto.getRandomValues(new Uint8Array(12));
        const rawMk = await window.crypto.subtle.exportKey('raw', this.masterKey);
        const ciphertextMK = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivMK }, wrappingKeyMK, rawMk);

        await api.users.setMasterKey(
            undefined, undefined, undefined, // Don't touch password wrap
            Array.from(new Uint8Array(ciphertextMK)).join(','),
            Array.from(mkSalt).join(','),
            Array.from(ivMK).join(',')
        );

        // 2. Wrap Local Key
        const lkSalt = window.crypto.getRandomValues(new Uint8Array(32));
        const wrappingKeyLK = await window.crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: lkSalt, info: new TextEncoder().encode('LocalKey_PRF') },
            prfKeyMK, // Can reuse imported PRF key
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt']
        );
        const wrappedLK = await this.wrapDeviceKey(this.localKey, wrappingKeyLK);

        // 3. Store Locally
        await this.initDB();
        const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readwrite');
        const store = tx.objectStore(KEYSTORE_STORE_NAME);
        const record = await new Promise(r => store.get(this.deviceId).onsuccess = e => r(e.target.result));
        
        record.deviceKeyWrapped.prf = {
            credentialId,
            salt: Array.from(lkSalt),
            iv: wrappedLK.iv,
            ciphertext: wrappedLK.ciphertext
        };
        record.updatedAt = Date.now();
        await new Promise(r => store.put(record).onsuccess = r);
        
        console.log('[Keystore] PRF wrapping established (Dual-Wrap)');
    }
}

export default new VaultService();
