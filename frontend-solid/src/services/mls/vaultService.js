// frontend-solid/src/services/mls/vaultService.js
import init, { MlsClient } from '@openmls'; // Use alias
import vaultStore from '../../store/vaultStore.js';
import coreCryptoClient from './coreCryptoClient.js';
// import messagingStore from '../../store/messagingStore.js'; // TODO: Implementation later
import { api } from '../api.js';

// Idle lock dependencies stubbed for now
const initIdleAutoLock = () => { };
const loadIdleLockConfig = () => { };

let wasmInitialized = false;

const KEYSTORE_DB_NAME = 'intellacc_keystore';
const KEYSTORE_DB_VERSION = 8;
const KEYSTORE_STORE_NAME = 'device_keystore';
const MESSAGES_STORE_NAME = 'encrypted_messages';
const MLS_GRANULAR_STORE_NAME = 'mls_granular_storage';
const CONTACT_FINGERPRINTS_STORE = 'contact_fingerprints';

class VaultService {
    constructor() {
        this.db = null;
        this.compositeKey = null;
        this.masterKey = null;
        this.localKey = null;
        this.deviceId = null;
        this.masterKeyCreated = false;
    }

    getDeviceId() {
        return this.deviceId;
    }

    isUnlocked() {
        return this.compositeKey !== null;
    }

    lock() {
        this.compositeKey = null;
        this.masterKey = null;
        this.localKey = null;
        this.deviceId = null;

        vaultStore.setVaultExists(false);
        vaultStore.setLocked(true);
        vaultStore.setUserId(null);
        console.log('[Vault] Locked');
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
        } catch { }
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
                    } catch (e) { }
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
                if (!db.objectStoreNames.contains(MLS_GRANULAR_STORE_NAME)) {
                    const store = db.createObjectStore(MLS_GRANULAR_STORE_NAME, { keyPath: 'id' });
                    store.createIndex('deviceId', 'deviceId', { unique: false });
                    store.createIndex('category', 'category', { unique: false });
                }
                if (!db.objectStoreNames.contains(CONTACT_FINGERPRINTS_STORE)) {
                    const store = db.createObjectStore(CONTACT_FINGERPRINTS_STORE, { keyPath: 'id' });
                    store.createIndex('contactUserId', 'contactUserId', { unique: false });
                    store.createIndex('status', 'status', { unique: false });
                    store.createIndex('deviceId', 'deviceId', { unique: false });
                }
            };
        });
    }

    async getLocalDeviceIds() {
        await this.initDB();
        return new Promise((resolve) => {
            const tx = this.db.transaction([KEYSTORE_STORE_NAME], 'readonly');
            const req = tx.objectStore(KEYSTORE_STORE_NAME).getAllKeys();
            req.onsuccess = () => {
                const ids = req.result || [];
                const linkedDeviceId = localStorage.getItem('device_public_id');
                if (linkedDeviceId && !ids.includes(linkedDeviceId)) {
                    ids.push(linkedDeviceId);
                }
                resolve(ids);
            };
            req.onerror = () => {
                const linkedDeviceId = localStorage.getItem('device_public_id');
                resolve(linkedDeviceId ? [linkedDeviceId] : []);
            };
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

    async deriveWrappingKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']
        );
        return window.crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    // NOTE: Added wrapDeviceKey helpers usually found in the class but were missing in the view? 
    // Wait, the original view had line 281: await this.wrapDeviceKey(...)
    // I need to make sure I implement these helper methods.

    async wrapDeviceKey(key, wrappingKey) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const rawKey = await window.crypto.subtle.exportKey('raw', key);
        const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey);
        return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
    }

    async unwrapDeviceKey(wrapped, wrappingKey) {
        const iv = new Uint8Array(wrapped.iv);
        const ciphertext = new Uint8Array(wrapped.ciphertext);
        const rawKey = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ciphertext);
        return window.crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    }

    async deriveCompositeKey(masterKey, localKey) {
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

                try {
                    const pwWrap = record.deviceKeyWrapped.password;
                    const salt = new Uint8Array(pwWrap.salt);
                    const wrappingKey = await this.deriveWrappingKey(password, salt);
                    this.localKey = await this.unwrapDeviceKey(pwWrap, wrappingKey);
                } catch (e) {
                    return resolve(false);
                }

                try {
                    this.compositeKey = await this.deriveCompositeKey(this.masterKey, this.localKey);

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
                } catch (e) { }
                resolve(false);
            };
            req.onerror = () => resolve(false);
        });
    }

    async setupKeystoreWithPassword(password, passedUserId = null) {
        const userId = passedUserId || vaultStore.userId;
        if (!userId) throw new Error('No user ID set');

        if (!this.masterKey) {
            this.masterKey = await this.getOrCreateMasterKey(password);
        }

        await this.initDB();
        const deviceId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : 'rand';

        this.localKey = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

        const passwordSalt = window.crypto.getRandomValues(new Uint8Array(32));
        const wrappingKey = await this.deriveWrappingKey(password, passwordSalt);
        const wrappedLK = await this.wrapDeviceKey(this.localKey, wrappingKey);

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
        this.deviceKey = this.compositeKey;

        try {
            const deviceName = `${navigator.platform || 'Web'} - ${navigator.userAgent.split('/')[0]}`;
            await api.devices.register(deviceId, deviceName);
        } catch (e) { }

        vaultStore.setVaultExists(true);
        vaultStore.setLocked(false);
        vaultStore.updateActivity();
        loadIdleLockConfig();
        initIdleAutoLock();

        coreCryptoClient.ensureKeyPackagesFresh().catch(e =>
            console.warn('[MLS] Key package upload failed:', e.message || e)
        );
    }

    async saveCurrentState() {
        if (!this.compositeKey || !this.deviceId) return false;

        const mlsState = await coreCryptoClient.exportStateForVault();
        if (!mlsState) return false;

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
                if (!record) return;

                record.encryptedDeviceState = {
                    iv: Array.from(stateIv),
                    ciphertext: Array.from(new Uint8Array(stateCipher))
                };
                record.updatedAt = Date.now();
                store.put(record);
                didWrite = true;
            };
            tx.oncomplete = () => resolve(didWrite);
            tx.onerror = () => reject(tx.error);
        });
    }

    async persistGranularEvents(events) {
        if (!this.compositeKey || !this.deviceId) return 0;
        if (!events || events.length === 0) return 0;

        await this.initDB();

        const preparedRecords = [];
        const deletions = [];

        for (const event of events) {
            const recordId = `${this.deviceId}:${event.category}:${event.key}`;

            if (event.value === null || event.value === undefined) {
                deletions.push(recordId);
            } else {
                const valueBytes = new Uint8Array(event.value);
                const iv = window.crypto.getRandomValues(new Uint8Array(12));
                const encrypted = await window.crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv },
                    this.compositeKey,
                    valueBytes
                );

                preparedRecords.push({
                    id: recordId,
                    deviceId: this.deviceId,
                    category: event.category,
                    key: event.key,
                    encryptedValue: {
                        iv: Array.from(iv),
                        ciphertext: Array.from(new Uint8Array(encrypted))
                    },
                    updatedAt: Date.now()
                });
            }
        }

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([MLS_GRANULAR_STORE_NAME], 'readwrite');
                const store = tx.objectStore(MLS_GRANULAR_STORE_NAME);

                for (const recordId of deletions) {
                    store.delete(recordId);
                }
                for (const record of preparedRecords) {
                    store.put(record);
                }

                const processed = deletions.length + preparedRecords.length;
                tx.oncomplete = () => resolve(processed);
                tx.onerror = () => reject(tx.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    async loadGranularEvents() {
        if (!this.compositeKey || !this.deviceId) return [];
        await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([MLS_GRANULAR_STORE_NAME], 'readonly');
            const store = tx.objectStore(MLS_GRANULAR_STORE_NAME);
            const index = store.index('deviceId');
            const req = index.getAll(this.deviceId);

            req.onsuccess = async () => {
                const records = req.result || [];
                const events = [];
                for (const record of records) {
                    try {
                        const iv = new Uint8Array(record.encryptedValue.iv);
                        const ciphertext = new Uint8Array(record.encryptedValue.ciphertext);
                        const decrypted = await window.crypto.subtle.decrypt(
                            { name: 'AES-GCM', iv },
                            this.compositeKey,
                            ciphertext
                        );
                        events.push({
                            key: record.key,
                            value: Array.from(new Uint8Array(decrypted)),
                            category: record.category
                        });
                    } catch (e) { }
                }
                resolve(events);
            };
            req.onerror = () => reject(req.error);
        });
    }
}

const instance = new VaultService();
export default instance;
