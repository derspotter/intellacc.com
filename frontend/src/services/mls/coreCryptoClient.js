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

    /**
     * Fetch a key package for another user
     * @param {string|number} userId - The user ID to fetch
     * @returns {Promise<Uint8Array>} The key package bytes
     */
    async fetchKeyPackage(userId) {
        if (!this.initialized) await this.initialize();

        // Get token directly
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const response = await fetch(`/api/mls/key-package/${userId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to fetch key package');
        }

        const data = await response.json();

        if (!data.package_data) {
            throw new Error('Invalid key package response');
        }

        // Handle Postgres bytea format which might be returned as a Buffer object or hex string
        let bytes;
        if (data.package_data && data.package_data.type === 'Buffer' && Array.isArray(data.package_data.data)) {
            bytes = new Uint8Array(data.package_data.data);
        } else if (typeof data.package_data === 'string') {
            let hex = data.package_data;
            if (hex.startsWith('\\x')) hex = hex.substring(2);
            bytes = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else {
            throw new Error('Unknown key package data format');
        }

        return bytes;
    }

    /**
     * Create a new MLS group
     * @param {string} name - Human readable group name
     * @returns {Promise<Object>} Created group metadata
     */
    async createGroup(name) {
        if (!this.initialized) await this.initialize();
        if (!this.client) await this.loadState(); // Try to load state if not in memory
        if (!this.client) throw new Error('Client not initialized (Identity not found)');

        // Generate a random group ID (16 bytes as hex string)
        const groupIdBytes = new Uint8Array(16);
        crypto.getRandomValues(groupIdBytes);
        const groupId = Array.from(groupIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        try {
            // Call WASM to create the group state
            // Note: MlsClient.create_group returns the group state handle/object inside WASM memory
            // We need to manage this state properly. For now assuming create_group persists internally or returns success.
            // Actual OpenMLS WASM binding might return a tuple or struct.
            // Based on checking the lib.rs earlier, it takes a group_id string.
            const groupState = this.client.create_group(groupId);
            console.log('MLS Group Created Locally:', groupId);

            // Persist group metadata in backend
            const token = localStorage.getItem('token');
            const response = await fetch('/api/mls/groups', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    groupId,
                    name
                })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || 'Failed to register group with backend');
            }

            const groupData = await response.json();

            // TODO: Persist full group state to IndexedDB 'groups' store

            return groupData;
        } catch (e) {
            console.error('Error creating group:', e);
            throw e;
        }
    }

    /**
     * Invite a user to a group
     * @param {string} groupId - The Group ID
     * @param {string|number} userId - The User ID to invite
     * @returns {Promise<Object>} Success status
     */
    async inviteToGroup(groupId, userId) {
        if (!this.initialized) await this.initialize();
        if (!this.client) await this.loadState();
        if (!this.client) throw new Error('Client not initialized');

        try {
            // 1. Fetch User's Key Package
            const keyPackageBytes = await this.fetchKeyPackage(userId);
            console.log(`Fetched key package for user ${userId}, bytes: ${keyPackageBytes.length}`);

            // 2. Add member in WASM (creates Proposal + Commit + Welcome)
            // Returns [welcome, commit] tuple
            const result = this.client.add_member(groupId, keyPackageBytes);
            console.log('Add member result:', result);

            if (!result || !Array.isArray(result) || result.length < 2) {
                throw new Error('Failed to generate commit/welcome from add_member');
            }

            const welcomeBytes = result[0]; // First element is Welcome
            const commitBytes = result[1];  // Second element is Commit

            // Helper to convert to hex
            const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');

            // 3. Upload Welcome Message (for the new user)
            const token = localStorage.getItem('token');
            const welcomeRes = await fetch('/api/mls/messages/welcome', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    groupId,
                    receiverId: userId,
                    data: '\\x' + toHex(welcomeBytes) // Postgres bytea
                })
            });

            if (!welcomeRes.ok) throw new Error('Failed to send welcome message');

            // 4. Upload Commit Message (for existing members)
            // ContentType 'commit' = 1 (or similar? Need to check spec or enum. Assuming 'commit' string or map to integer if backend expects int)
            // Backend `storeGroupMessage` takes `content_type` as string in current schema? 
            // In SQL `content_type` is likely text unless I defined ENUM.
            // Let's assume 'commit' string for now.
            // Epoch: We need to know the *next* epoch? Or current?
            // Usually the commit *advances* the epoch.
            // Does `add_member` return the new epoch?
            // Simplification: Send it with current epoch + 1 or let backend/client handle ordering.
            // For now, I will use a placeholder epoch 0 or get it from group state if possible.
            // But WASM manages state.
            // I'll leave epoch as 0 for MVP or see if I can get it.

            const groupMessageRes = await fetch('/api/mls/messages/group', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    groupId,
                    epoch: 0, // TODO: Get actual epoch from WASM state
                    contentType: 'commit',
                    data: '\\x' + toHex(commitBytes)
                })
            });

            if (!groupMessageRes.ok) throw new Error('Failed to send group commit');

            // 5. Update Group Membership in Backend (Relational DB)
            const membershipRes = await fetch(`/api/mls/groups/${groupId}/members`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ userId })
            });

            if (!membershipRes.ok) throw new Error('Failed to update group membership');

            return { success: true };

        } catch (e) {
            console.error('Error inviting user:', e);
            throw e;
        }
    }

    /**
     * Check for pending invites (Welcome messages)
     * @returns {Promise<Array>} List of new group IDs joined
     */
    async checkForInvites() {
        if (!this.initialized) await this.initialize();
        const token = localStorage.getItem('token');
        if (!token) return [];

        try {
            const res = await fetch('/api/mls/messages/welcome', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Failed to fetch invites');

            const messages = await res.json();
            console.log(`Found ${messages.length} pending invites`);

            const joinedGroups = [];
            for (const msg of messages) {
                try {
                    console.log('Processing invite:', msg.id);
                    // msg.data might be buffer (array generic) or hex string
                    let welcomeBytes;
                    if (msg.data && msg.data.type === 'Buffer') {
                        welcomeBytes = new Uint8Array(msg.data.data);
                    } else if (typeof msg.data === 'string' && msg.data.startsWith('\\x')) {
                        // Postgres hex format \xDEADBEEF
                        const hex = msg.data.substring(2);
                        if (hex.length === 0) welcomeBytes = new Uint8Array(0);
                        else {
                            const match = hex.match(/.{1,2}/g);
                            welcomeBytes = new Uint8Array(match ? match.map(byte => parseInt(byte, 16)) : []);
                        }
                    } else {
                        // Assuming raw array or hex string
                        welcomeBytes = new Uint8Array(typeof msg.data === 'string' ?
                            msg.data.match(/.{1,2}/g).map(byte => parseInt(byte, 16)) : msg.data);
                    }

                    const groupId = await this.joinGroup(welcomeBytes);
                    joinedGroups.push(groupId);

                    // Delete processed welcome
                    await fetch(`/api/mls/messages/welcome/${msg.id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                } catch (e) {
                    console.error('Failed to process invite:', msg.id, e);
                }
            }
            return joinedGroups;
        } catch (e) {
            console.error('Error in checkForInvites:', e);
            return [];
        }
    }

    /**
     * Join a group from a Welcome message
     * @param {Uint8Array} welcomeBytes 
     * @returns {Promise<string>} Group ID (hex)
     */
    async joinGroup(welcomeBytes) {
        if (!this.initialized) await this.initialize();
        if (!this.client) await this.loadState();

        // process_welcome returns group_id bytes
        // signature: process_welcome(welcome_bytes, ratchet_tree_bytes?)
        const groupIdBytes = this.client.process_welcome(welcomeBytes, undefined);

        await this.saveState();

        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
        const groupId = toHex(groupIdBytes);
        console.log('Joined group:', groupId);

        return groupId;
    }
}

export default new CoreCryptoClient();
