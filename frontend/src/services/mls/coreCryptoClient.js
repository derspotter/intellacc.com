import init, { MlsClient, init_logging } from 'openmls-wasm';

/**
 * Core Crypto Client for OpenMLS integration
 * Handles WASM initialization and wraps the Rust MlsClient
 */
class CoreCryptoClient {
    constructor() {
        this.client = null;
        this.initialized = false;
        this.identityName = null;
        this.dbName = 'openmls_storage';
        this.dbVersion = 1;
        this.db = null;
    }

    /**
     * Initialize the WASM module and logging
     */
    async initialize() {
        if (this.initialized) return;

        try {
            await init();
            init_logging();
            await this.initDB();
            this.initialized = true;
            console.log('OpenMLS WASM module initialized');
        } catch (error) {
            console.error('Failed to initialize OpenMLS WASM:', error);
            throw new Error('Crypto initialization failed');
        }
    }

    /**
     * Initialize IndexedDB
     */
    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('state')) {
                    db.createObjectStore('state', { keyPath: 'id' });
                }
            };
        });
    }

    /**
     * Save client state to IndexedDB
     */
    async saveState() {
        if (!this.client || !this.db) return;
        try {
            const credential = this.client.get_credential_bytes();
            const bundle = this.client.get_key_package_bundle_bytes();
            const signatureKey = this.client.get_signature_keypair_bytes();

            const transaction = this.db.transaction(['state'], 'readwrite');
            const store = transaction.objectStore('state');

            await new Promise((resolve, reject) => {
                const request = store.put({
                    id: 'current_identity',
                    credential,
                    bundle,
                    signatureKey,
                    identityName: this.identityName,
                    updatedAt: Date.now()
                });
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
            console.log('OpenMLS state saved');
        } catch (error) {
            console.error('Error saving OpenMLS state:', error);
        }
    }

    /**
     * Load client state from IndexedDB
     */
    async loadState() {
        if (!this.db) return false;
        try {
            const transaction = this.db.transaction(['state'], 'readonly');
            const store = transaction.objectStore('state');

            const record = await new Promise((resolve, reject) => {
                const request = store.get('current_identity');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
            });

            if (record && record.credential && record.bundle && record.signatureKey) {
                this.client = new MlsClient();
                this.client.restore_identity(record.credential, record.bundle, record.signatureKey);
                this.identityName = record.identityName;
                console.log('OpenMLS state restored for:', this.identityName);
                return true;
            }
        } catch (error) {
            console.error('Error loading OpenMLS state:', error);
        }
        return false;
    }

    /**
     * Ensure the client is bootstrapped with an identity
     * @param {string} username - The username to create an identity for
     */
    async ensureMlsBootstrap(username) {
        if (!this.initialized) await this.initialize();

        if (this.client) {
            console.log('MLS Client already initialized');
            return;
        }

        // Try to load existing state
        if (await this.loadState()) {
            if (this.identityName === username) {
                // Upload key package to ensure server has it
                try {
                    await this.uploadKeyPackage();
                } catch (uploadError) {
                    console.warn('Failed to upload key package:', uploadError);
                }
                return;
            }
            console.warn('Stored identity does not match requested username, resetting...');
            this.client = null;
        }

        try {
            this.client = new MlsClient();
            this.identityName = username;

            // Create identity and generate keys
            // This stores the KeyPackageBundle (private keys) in the WASM memory
            const result = this.client.create_identity(username);
            console.log('Identity created:', result);

            // Persist state
            await this.saveState();

            // Upload key package to server
            try {
                await this.uploadKeyPackage();
            } catch (uploadError) {
                console.warn('Failed to upload key package:', uploadError);
                // Continue even if upload fails - can retry later
            }
        } catch (error) {
            console.error('Error bootstrapping MLS client:', error);
            throw error;
        }
    }

    /**
     * Get the public KeyPackage bytes for this client
     * @returns {Uint8Array} The serialized KeyPackage
     */
    getKeyPackageBytes() {
        if (!this.client) throw new Error('Client not initialized');
        return this.client.get_key_package_bytes();
    }

    /**
     * Get the public KeyPackage as a hex string (for API transport)
     * @returns {string} Hex string of the KeyPackage
     */
    getKeyPackageHex() {
        const bytes = this.getKeyPackageBytes();
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    /**
     * Compute SHA-256 hash of data and return as hex string
     * @param {Uint8Array} data - Data to hash
     * @returns {Promise<string>} Hex string of hash
     */
    async computeHash(data) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Upload the key package to the server
     * @param {string} deviceId - Device identifier (defaults to 'default')
     * @returns {Promise<Object>} Server response
     */
    async uploadKeyPackage(deviceId = 'default') {
        if (!this.client) throw new Error('Client not initialized');

        // Get token directly from localStorage to avoid circular import with auth.js
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const keyPackageBytes = this.getKeyPackageBytes();
        const keyPackageHex = this.getKeyPackageHex();
        const hash = await this.computeHash(keyPackageBytes);

        // Format for postgres bytea: \x prefix
        const packageData = '\\x' + keyPackageHex;

        const response = await fetch('/api/mls/key-package', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                deviceId,
                packageData,
                hash
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to upload key package');
        }

        const result = await response.json();
        console.log('Key package uploaded successfully:', result);
        return result;
    }
}

// Singleton instance
const coreCryptoClient = new CoreCryptoClient();
export default coreCryptoClient;
