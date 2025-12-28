import init, { MlsClient, init_logging } from 'openmls-wasm';
import { registerSocketEventHandler } from '../socket.js';
import { api } from '../api.js';

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
        this.dbVersion = 2; // Bumped for granular_events store
        this.db = null;
        this.messageHandlers = []; // Callbacks for decrypted messages
        this.welcomeHandlers = []; // Callbacks for new group invites
        this._socketCleanup = null;
        this.processedMessageIds = new Set(); // Track processed message IDs to prevent duplicates
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
                // [NEW] Granular Event Store for O(1) writes
                if (!db.objectStoreNames.contains('granular_events')) {
                    // key is the hex key from Rust
                    db.createObjectStore('granular_events');
                }
            };
        });
    }

    /**
     * Save client state to IndexedDB for current user
     * Uses per-user storage keys to support multiple identities
     */
    async saveState() {
        if (!this.client || !this.db || !this.identityName) return;
        try {
            // --- 1. Granular Write-Behind (New O(1) path) ---
            try {
                // Drain dirty events from Rust memory
                // events = [{ key: "hex...", value: Uint8Array | null, category: "..." }]
                const events = this.client.drain_storage_events();

                if (events && events.length > 0) {
                    const tx = this.db.transaction(['granular_events'], 'readwrite');
                    const store = tx.objectStore('granular_events');

                    // Process all events
                    // Note: This effectively mirrors the Rust HashMap in IndexedDB
                    for (const event of events) {
                        if (event.value === null || event.value === undefined) {
                            store.delete(event.key);
                        } else {
                            // event.value comes as number[] from serde, need Uint8Array
                            // BUT serde-wasm-bindgen usually handles Uint8Array -> Uint8Array if configured,
                            // or simple array. Let's ensure it's stored efficiently.
                            // If it's a raw array, IndexedDB handles it, but Uint8Array is better.
                            store.put(event.value, event.key);
                        }
                    }

                    await new Promise((resolve, reject) => {
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => reject(tx.error);
                    });
                    console.log(`[MLS] Persisted ${events.length} granular events`);
                }
            } catch (e) {
                console.warn('[MLS] Granular persistence failed:', e);
            }

            // --- 2. Snapshot Fallback (Legacy/Reliability) ---
            // We keep this for now because we haven't implemented "Load from Granular" yet.
            // This ensures we can still restore state on reload.

            const credential = this.client.get_credential_bytes();
            const bundle = this.client.get_key_package_bundle_bytes();
            const signatureKey = this.client.get_signature_keypair_bytes();

            // Export full storage state (includes groups, epoch secrets, etc.)
            let storageState = null;
            try {
                storageState = this.client.export_storage_state();
            } catch (e) {
                console.warn('Could not export detailed storage state provided by Wasm:', e);
            }

            const transaction = this.db.transaction(['state'], 'readwrite');
            const store = transaction.objectStore('state');

            // Store with per-user key: identity_${username}
            await new Promise((resolve, reject) => {
                const request = store.put({
                    id: `identity_${this.identityName}`,
                    credential,
                    bundle,
                    signatureKey,
                    storageState, // Persist the full vault state
                    identityName: this.identityName,
                    updatedAt: Date.now()
                });
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
            console.log('OpenMLS state (Identity + Vault) saved for:', this.identityName);
        } catch (error) {
            console.error('Error saving OpenMLS state:', error);
        }
    }

    /**
     * Load client state from IndexedDB for a specific user
     * @param {string} username - The username to load state for
     * @returns {boolean} True if state was loaded successfully
     */
    async loadState(username) {
        if (!this.db) return false;
        if (!username) {
            console.warn('loadState called without username');
            return false;
        }

        try {
            const transaction = this.db.transaction(['state'], 'readonly');
            const store = transaction.objectStore('state');

            // Load using per-user key: identity_${username}
            const record = await new Promise((resolve, reject) => {
                const request = store.get(`identity_${username}`);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
            });

            if (record && record.credential && record.bundle && record.signatureKey) {
                this.client = new MlsClient();
                this.client.restore_identity(record.credential, record.bundle, record.signatureKey);

                // Restore full storage state (groups, epoch secrets, etc.)
                if (record.storageState) {
                    try {
                        // Ensure it's a Uint8Array (IndexedDB might return ArrayBuffer or plain array depending on browser/adapter)
                        const storageBytes = record.storageState instanceof Uint8Array
                            ? record.storageState
                            : new Uint8Array(record.storageState);

                        this.client.import_storage_state(storageBytes);
                        console.log('Restored OpenMLS storage state (groups/keys)');
                    } catch (e) {
                        console.error('Failed to import storage state:', e);
                    }
                }

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

        // If client exists for the correct user, we're done
        if (this.client && this.identityName === username) {
            console.log('MLS Client already initialized for:', username);
            this.setupSocketListeners();
            return;
        }

        // Reset client if switching users
        if (this.client && this.identityName !== username) {
            console.log('Switching MLS identity from', this.identityName, 'to', username);
            this.cleanupSocketListeners();
            this.client = null;
            this.identityName = null;
        }

        // Try to load existing state for this specific user
        if (await this.loadState(username)) {
            // Successfully loaded - upload key package to ensure server has it
            try {
                await this.uploadKeyPackage();
            } catch (uploadError) {
                console.warn('Failed to upload key package:', uploadError);
            }
            this.setupSocketListeners();
            return;
        }

        // No existing state found - create new identity
        try {
            this.client = new MlsClient();
            this.identityName = username;

            // Create identity and generate keys
            // This stores the KeyPackageBundle (private keys) in the WASM memory
            const result = this.client.create_identity(username);
            console.log('Identity created:', result);

            // Persist state for this user
            await this.saveState();

            // Save to vault if unlocked (new identity needs to be persisted)
            try {
                const vaultService = (await import('../vaultService.js')).default;
                await vaultService.saveCurrentState();
                console.log('[MLS] New identity saved to vault');
            } catch (vaultErr) {
                console.warn('[MLS] Could not save identity to vault:', vaultErr.message);
            }

            // Upload key package to server
            try {
                await this.uploadKeyPackage();
            } catch (uploadError) {
                console.warn('Failed to upload key package:', uploadError);
                // Continue even if upload fails - can retry later
            }

            // Set up real-time socket listeners
            this.setupSocketListeners();
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
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized (Identity not found)');

        // Generate a random group ID (16 bytes as hex string)
        const groupIdBytes = new Uint8Array(16);
        crypto.getRandomValues(groupIdBytes);
        const groupId = Array.from(groupIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        try {
            // Call WASM to create the group state
            // WASM expects raw bytes, not hex string
            const groupState = this.client.create_group(groupIdBytes);
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

            // Persist state to IndexedDB
            await this.saveState();

            // Save to vault if unlocked (dynamic import to avoid circular dependency)
            try {
                const vaultService = (await import('../vaultService.js')).default;
                await vaultService.saveCurrentState();
                console.log('[MLS] Group state saved to vault');
            } catch (vaultErr) {
                console.warn('[MLS] Could not save to vault:', vaultErr.message);
            }

            return groupData;
        } catch (e) {
            console.error('Error creating group:', e);
            throw e;
        }
    }

    /**
     * Start a direct message with another user
     * Creates a DM group or returns existing one
     * @param {string|number} targetUserId - The user ID to DM
     * @returns {Promise<Object>} { groupId, isNew, otherUsername }
     */
    async startDirectMessage(targetUserId) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        try {
            // Get or create DM group on backend
            const result = await api.mls.createDirectMessage(targetUserId);
            const { groupId, isNew } = result;

            if (isNew) {
                // Create group locally in WASM
                const groupIdBytes = new Uint8Array(groupId.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
                this.client.create_group(groupIdBytes);
                console.log('[MLS] Created local DM group:', groupId);

                // Persist state
                await this.saveState();

                // Invite the target user
                await this.inviteToGroup(groupId, targetUserId);
                console.log('[MLS] Invited user to DM:', targetUserId);
            }

            return { groupId, isNew };
        } catch (e) {
            console.error('[MLS] Error starting direct message:', e);
            throw e;
        }
    }

    /**
     * Check if a group is a DM (by checking the group ID format)
     * DM group IDs have the format: dm_{userA}_{userB}
     * @param {string} groupId - The group ID to check
     * @returns {boolean} True if this is a DM group
     */
    isDirectMessage(groupId) {
        return groupId && groupId.startsWith('dm_');
    }

    /**
     * Invite a user to a group
     * @param {string} groupId - The Group ID
     * @param {string|number} userId - The User ID to invite
     * @returns {Promise<Object>} Success status
     */
    async inviteToGroup(groupId, userId) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        try {
            // 1. Fetch User's Key Package
            const keyPackageBytes = await this.fetchKeyPackage(userId);
            console.log(`Fetched key package for user ${userId}, bytes: ${keyPackageBytes.length}`);

            // 2. Convert groupId to bytes for WASM
            const groupIdBytes = new Uint8Array(groupId.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

            // 3. Add member in WASM (creates Proposal + Commit + Welcome)
            // Returns [welcome, commit] tuple
            const result = this.client.add_member(groupIdBytes, keyPackageBytes);
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

            // Save state after adding member (group state changed)
            await this.saveState();

            // Save to vault if unlocked
            try {
                const vaultService = (await import('../vaultService.js')).default;
                await vaultService.saveCurrentState();
                console.log('[MLS] Invite state saved to vault');
            } catch (vaultErr) {
                console.warn('[MLS] Could not save to vault:', vaultErr.message);
            }

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
        if (!this.client && this.identityName) await this.loadState(this.identityName);

        // process_welcome returns group_id bytes
        // signature: process_welcome(welcome_bytes, ratchet_tree_bytes?)
        const groupIdBytes = this.client.process_welcome(welcomeBytes, undefined);

        await this.saveState();

        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
        const groupId = toHex(groupIdBytes);
        console.log('Joined group:', groupId);

        // Regenerate KeyPackage after joining (it was consumed by process_welcome)
        await this.regenerateKeyPackage();

        // Save to vault if unlocked (dynamic import to avoid circular dependency)
        try {
            const vaultService = (await import('../vaultService.js')).default;
            await vaultService.saveCurrentState();
            console.log('[MLS] Join group state saved to vault');
        } catch (vaultErr) {
            console.warn('[MLS] Could not save to vault:', vaultErr.message);
        }

        return groupId;
    }

    /**
     * Regenerate KeyPackage after it's been consumed (e.g., by joining a group)
     * Per OpenMLS Book: KeyPackages are single-use
     * @returns {Promise<void>}
     */
    async regenerateKeyPackage() {
        if (!this.client) throw new Error('Client not initialized');

        // Generate new KeyPackage in WASM
        this.client.regenerate_key_package();
        console.log('[MLS] KeyPackage regenerated');

        // Save updated state
        await this.saveState();

        // Upload new KeyPackage to server
        try {
            await this.uploadKeyPackage();
            console.log('[MLS] New KeyPackage uploaded to server');
        } catch (e) {
            console.warn('[MLS] Failed to upload new KeyPackage:', e);
        }
    }

    /**
     * Send an encrypted message to a group
     * Per OpenMLS Book (p.45 "Creating application messages")
     * @param {Uint8Array|string} groupId - The group ID (bytes or hex string)
     * @param {string} plaintext - The message to encrypt
     * @returns {Promise<Object>} Server response with message ID
     */
    async sendMessage(groupId, plaintext) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        // Convert groupId to bytes if it's a hex string
        let groupIdBytes;
        if (typeof groupId === 'string') {
            groupIdBytes = new Uint8Array(groupId.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else {
            groupIdBytes = groupId;
        }

        // Convert plaintext to bytes
        const encoder = new TextEncoder();
        const plaintextBytes = encoder.encode(plaintext);

        // Encrypt the message using WASM
        const ciphertextBytes = this.client.encrypt_message(groupIdBytes, plaintextBytes);
        console.log(`[MLS] Encrypted message: ${plaintextBytes.length} bytes -> ${ciphertextBytes.length} bytes`);

        // Convert to hex for PostgreSQL bytea storage
        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
        const ciphertextHex = '\\x' + toHex(ciphertextBytes);
        const groupIdHex = typeof groupId === 'string' ? groupId : toHex(groupId);

        // Send to server
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const response = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                groupId: groupIdHex,
                epoch: 0,
                contentType: 'application',
                data: ciphertextHex
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to send message');
        }

        const result = await response.json();
        console.log('[MLS] Message sent:', result.id);

        // Store plaintext for own message history (can't decrypt own messages in MLS)
        try {
            this.client.store_sent_message(groupIdBytes, String(result.id), plaintext);
            console.log('[MLS] Stored sent message for history:', result.id);
            // Save state to persist sent message
            const vaultService = (await import('../vaultService.js')).default;
            await vaultService.saveCurrentState();
        } catch (e) {
            console.warn('[MLS] Failed to store sent message:', e);
        }

        return result;
    }

    /**
     * Decrypt an incoming message
     * Per OpenMLS Book (p.48-49 "Processing messages in groups")
     * @param {Uint8Array|string} groupId - The group ID (bytes or hex string)
     * @param {Uint8Array|string|Object} ciphertext - The encrypted message
     * @returns {string} The decrypted plaintext
     */
    decryptMessage(groupId, ciphertext) {
        if (!this.client) throw new Error('Client not initialized');

        // Convert groupId to bytes if it's a hex string
        let groupIdBytes;
        if (typeof groupId === 'string') {
            groupIdBytes = new Uint8Array(groupId.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else {
            groupIdBytes = groupId;
        }

        // Convert ciphertext to bytes if needed
        let ciphertextBytes;
        if (typeof ciphertext === 'string') {
            let hex = ciphertext;
            if (hex.startsWith('\\x')) hex = hex.substring(2);
            ciphertextBytes = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else if (ciphertext.type === 'Buffer' && Array.isArray(ciphertext.data)) {
            ciphertextBytes = new Uint8Array(ciphertext.data);
        } else {
            ciphertextBytes = ciphertext;
        }

        // Decrypt using WASM
        const plaintextBytes = this.client.decrypt_message(groupIdBytes, ciphertextBytes);

        // Convert bytes back to string
        const decoder = new TextDecoder();
        const plaintext = decoder.decode(plaintextBytes);
        console.log(`[MLS] Decrypted message: ${ciphertextBytes.length} bytes -> "${plaintext}"`);

        return plaintext;
    }

    /**
     * Handle an incoming encrypted message from the server
     * @param {Object} messageData - Message object from server/socket
     * @returns {Promise<Object>} Processed message with plaintext
     */
    async handleIncomingMessage(messageData) {
        if (!this.client) throw new Error('Client not initialized');

        const { group_id, data, content_type, sender_id, id } = messageData;

        // Skip already processed messages (deduplication)
        if (id && this.processedMessageIds.has(id)) {
            console.log('[MLS] Skipping already processed message:', id);
            return { id, groupId: group_id, senderId: sender_id, type: 'duplicate', skipped: true };
        }

        if (content_type === 'application') {
            // Check if this is our own message (can't decrypt own messages in MLS)
            const isOwnMessage = String(sender_id) === String(this.identityName);

            if (isOwnMessage) {
                // Retrieve from local storage
                try {
                    const groupIdBytes = new Uint8Array(group_id.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
                    const storedPlaintext = this.client.get_sent_message(groupIdBytes, String(id));
                    if (storedPlaintext) {
                        console.log('[MLS] Retrieved own message from storage:', id);
                        if (id) this.processedMessageIds.add(id);
                        return { id, groupId: group_id, senderId: sender_id, plaintext: storedPlaintext, type: 'application' };
                    }
                    console.warn('[MLS] Own message not found in storage:', id);
                } catch (e) {
                    console.warn('[MLS] Error retrieving own message:', e);
                }
                // If not found, we can't recover it - return without plaintext
                if (id) this.processedMessageIds.add(id);
                return { id, groupId: group_id, senderId: sender_id, plaintext: '[Message unavailable]', type: 'application' };
            }

            // Not our message - decrypt normally
            const plaintext = this.decryptMessage(group_id, data);
            if (id) this.processedMessageIds.add(id);
            return { id, groupId: group_id, senderId: sender_id, plaintext, type: 'application' };
        } else if (content_type === 'commit') {
            await this.processCommit(group_id, data);
            if (id) this.processedMessageIds.add(id);
            return { id, groupId: group_id, senderId: sender_id, type: 'commit' };
        } else {
            console.warn('[MLS] Unknown message content_type:', content_type);
            if (id) this.processedMessageIds.add(id);
            return { id, groupId: group_id, type: 'unknown' };
        }
    }

    /**
     * Process a commit message (for member changes, key updates)
     * Commits advance the epoch and may change group membership
     * @param {string} groupId - Group ID (hex)
     * @param {Object|string} commitData - Commit message data
     */
    async processCommit(groupId, commitData) {
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = new Uint8Array(groupId.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

        let commitBytes;
        if (typeof commitData === 'string') {
            let hex = commitData;
            if (hex.startsWith('\\x')) hex = hex.substring(2);
            commitBytes = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else if (commitData.type === 'Buffer' && Array.isArray(commitData.data)) {
            commitBytes = new Uint8Array(commitData.data);
        } else {
            commitBytes = commitData;
        }

        this.client.process_commit(groupIdBytes, commitBytes);
        console.log('[MLS] Processed commit for group:', groupId);

        // Save state after processing commit (epoch advanced, keys rotated)
        await this.saveState();

        // Persist to vault if unlocked
        try {
            const vaultService = (await import('../vaultService.js')).default;
            await vaultService.saveCurrentState();
            console.log('[MLS] Commit state saved to vault');
        } catch (vaultErr) {
            console.warn('[MLS] Could not save commit state to vault:', vaultErr.message);
        }
    }

    /**
     * Fetch and process new messages for a group
     * @param {string} groupId - Group ID (hex)
     * @param {number} afterId - Fetch messages after this ID
     * @returns {Promise<Array>} Array of processed messages with plaintext
     */
    async fetchAndDecryptMessages(groupId, afterId = 0) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const response = await fetch(`/api/mls/messages/group/${groupId}?afterId=${afterId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to fetch messages');
        }

        const messages = await response.json();
        console.log(`[MLS] Fetched ${messages.length} messages for group ${groupId}`);

        const processed = [];
        for (const msg of messages) {
            try {
                const result = await this.handleIncomingMessage(msg);
                processed.push(result);
            } catch (e) {
                console.error('[MLS] Failed to process message:', msg.id, e);
            }
        }

        return processed;
    }

    /**
     * Export the current IndexedDB state for backup
     * @returns {Promise<Object|null>} The exported state object or null if no state exists
     */
    async exportState() {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['state'], 'readonly');
            const store = transaction.objectStore('state');
            const request = store.get('current_identity');

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const record = request.result;
                if (record) {
                    // Convert Uint8Arrays to regular arrays for JSON serialization
                    const exported = {
                        id: record.id,
                        credential: Array.from(record.credential),
                        bundle: Array.from(record.bundle),
                        signatureKey: Array.from(record.signatureKey),
                        identityName: record.identityName,
                        updatedAt: record.updatedAt
                    };
                    console.log('State exported for:', record.identityName);
                    resolve(exported);
                } else {
                    resolve(null);
                }
            };
        });
    }

    /**
     * Import a previously exported state into IndexedDB
     * @param {Object} exportedState - The state object from exportState()
     * @returns {Promise<void>}
     */
    async importState(exportedState) {
        if (!exportedState) throw new Error('No state to import');
        if (!this.db) await this.initDB();

        // Convert arrays back to Uint8Arrays
        const record = {
            id: exportedState.id,
            credential: new Uint8Array(exportedState.credential),
            bundle: new Uint8Array(exportedState.bundle),
            signatureKey: new Uint8Array(exportedState.signatureKey),
            identityName: exportedState.identityName,
            updatedAt: exportedState.updatedAt
        };

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['state'], 'readwrite');
            const store = transaction.objectStore('state');
            const request = store.put(record);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                console.log('State imported for:', record.identityName);
                resolve();
            };
        });
    }

    /**
     * Clear all stored state (for switching users)
     * @returns {Promise<void>}
     */
    async clearState() {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['state'], 'readwrite');
            const store = transaction.objectStore('state');
            const request = store.clear();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.client = null;
                this.identityName = null;
                console.log('State cleared');
                resolve();
            };
        });
    }

    /**
     * Register a handler for decrypted messages
     * @param {Function} handler - Callback(message) where message = { id, groupId, senderId, plaintext, type }
     * @returns {Function} Unregister function
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
        return () => {
            this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
        };
    }

    /**
     * Register a handler for new group invites
     * @param {Function} handler - Callback({ groupId })
     * @returns {Function} Unregister function
     */
    onWelcome(handler) {
        this.welcomeHandlers.push(handler);
        return () => {
            this.welcomeHandlers = this.welcomeHandlers.filter(h => h !== handler);
        };
    }

    /**
     * Set up socket event listeners for real-time MLS events
     */
    setupSocketListeners() {
        if (this._socketCleanup) return; // Already set up

        const cleanupWelcome = registerSocketEventHandler('mls-welcome', async (data) => {
            console.log('[MLS] Real-time welcome received:', data);
            try {
                // Fetch and process the welcome
                const joinedGroups = await this.checkForInvites();
                // Notify handlers
                for (const groupId of joinedGroups) {
                    this.welcomeHandlers.forEach(h => h({ groupId }));
                }
            } catch (e) {
                console.error('[MLS] Error processing welcome:', e);
            }
        });

        const cleanupMessage = registerSocketEventHandler('mls-message', async (data) => {
            console.log('[MLS] Real-time message received:', data);
            try {
                // Fetch and decrypt the message
                const messages = await this.fetchAndDecryptMessages(data.groupId, data.id - 1);
                // Notify handlers
                for (const msg of messages) {
                    this.messageHandlers.forEach(h => h(msg));
                }
            } catch (e) {
                console.error('[MLS] Error processing message:', e);
            }
        });

        this._socketCleanup = () => {
            cleanupWelcome();
            cleanupMessage();
        };
        console.log('[MLS] Socket listeners set up');
    }

    /**
     * Clean up socket listeners
     */
    cleanupSocketListeners() {
        if (this._socketCleanup) {
            this._socketCleanup();
            this._socketCleanup = null;
        }
    }

    /**
     * Export MLS state for vault encryption
     * Returns a plain object with arrays (for JSON serialization)
     * Includes identity AND full storage state (groups, keys, etc.)
     * @returns {Promise<Object|null>} State object or null if no state
     */
    async exportStateForVault() {
        console.log('[MLS] exportStateForVault called, client:', !!this.client, 'identity:', this.identityName);

        if (!this.client || !this.identityName) {
            console.warn('[MLS] No state to export for vault');
            return null;
        }

        try {
            const credential = this.client.get_credential_bytes();
            const bundle = this.client.get_key_package_bundle_bytes();
            const signatureKey = this.client.get_signature_keypair_bytes();

            // Export full storage state (includes groups, epoch secrets, etc.)
            const storageState = this.client.export_storage_state();
            console.log('[MLS] exportStateForVault: storageState bytes:', storageState.length);

            // Log the group count from the exported storage state
            // The format is: [MemoryStorage bytes][8-byte group count][group IDs...]
            // We need to find where the group count is - it's after MemoryStorage
            // This is a simplified check - just log the state size

            return {
                credential: Array.from(credential),
                bundle: Array.from(bundle),
                signatureKey: Array.from(signatureKey),
                storageState: Array.from(storageState),
                identityName: this.identityName,
                exportedAt: Date.now()
            };
        } catch (error) {
            console.error('[MLS] Error exporting state for vault:', error);
            return null;
        }
    }

    /**
     * Restore MLS state from vault-decrypted data
     * @param {Object} stateObj - State object from exportStateForVault
     * @returns {Promise<boolean>} True if restored successfully
     */
    async restoreStateFromVault(stateObj) {
        if (!stateObj || !stateObj.credential || !stateObj.bundle || !stateObj.signatureKey) {
            console.error('[MLS] Invalid vault state object');
            return false;
        }

        if (!this.initialized) await this.initialize();

        try {
            // Convert arrays back to Uint8Array
            const credential = new Uint8Array(stateObj.credential);
            const bundle = new Uint8Array(stateObj.bundle);
            const signatureKey = new Uint8Array(stateObj.signatureKey);

            // Create new client and restore identity
            this.client = new MlsClient();
            this.client.restore_identity(credential, bundle, signatureKey);
            this.identityName = stateObj.identityName;

            // Restore full storage state (groups, epoch secrets, etc.) if available
            if (stateObj.storageState && stateObj.storageState.length > 0) {
                const storageState = new Uint8Array(stateObj.storageState);
                this.client.import_storage_state(storageState);
                console.log('[MLS] Full storage state restored from vault');
            }

            // Set up socket listeners
            this.setupSocketListeners();

            // ALWAYS check for pending Welcome messages (new group invites)
            // This must happen AFTER vault restore to merge new groups with existing state
            const joinedGroups = await this.checkForInvites();
            if (joinedGroups.length > 0) {
                console.log('[MLS] Processed pending invites after vault restore:', joinedGroups);
                // Save updated state with new groups to vault
                try {
                    const vaultService = (await import('../vaultService.js')).default;
                    await vaultService.saveCurrentState();
                    console.log('[MLS] New group state saved to vault');
                } catch (vaultErr) {
                    console.warn('[MLS] Could not save new group state to vault:', vaultErr.message);
                }
            }

            console.log('[MLS] State restored from vault for:', this.identityName);
            return true;
        } catch (error) {
            console.error('[MLS] Error restoring state from vault:', error);
            return false;
        }
    }

    /**
     * Re-sync groups from server after vault unlock
     * Processes any pending invites and logs missing groups
     */
    async resyncGroupsFromServer() {
        const token = localStorage.getItem('token');
        if (!token) return;

        try {
            // 1. Check for any pending Welcome messages (new invites)
            const joinedGroups = await this.checkForInvites();
            if (joinedGroups.length > 0) {
                console.log('[MLS] Processed pending invites, joined groups:', joinedGroups);
            }

            // 2. Fetch list of groups user is a member of from server
            const response = await fetch('/api/mls/groups', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) {
                console.warn('[MLS] Could not fetch groups from server');
                return;
            }

            const serverGroups = await response.json();
            console.log('[MLS] Server reports membership in', serverGroups.length, 'groups');

            // 3. Check which groups are missing locally
            const missingGroups = [];
            for (const group of serverGroups) {
                const groupIdHex = group.group_id;
                const groupIdBytes = new Uint8Array(groupIdHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

                if (!this.client.has_group(groupIdBytes)) {
                    missingGroups.push({
                        id: groupIdHex,
                        name: group.name
                    });
                }
            }

            if (missingGroups.length > 0) {
                console.warn('[MLS] Missing local state for groups:', missingGroups.map(g => g.name).join(', '));
                console.warn('[MLS] These groups need re-invitation to restore E2EE messaging');
                // Store missing groups for UI to display
                this._missingGroups = missingGroups;
            } else {
                console.log('[MLS] All groups synced successfully');
                this._missingGroups = [];
            }
        } catch (error) {
            console.error('[MLS] Error re-syncing groups:', error);
        }
    }

    /**
     * Get list of groups that are missing local state after vault unlock
     * @returns {Array} List of {id, name} objects for groups needing re-invitation
     */
    getMissingGroups() {
        return this._missingGroups || [];
    }

    /**
     * Get the identity fingerprint (Safety Number) for the current user
     * This is a SHA-256 hash of the MLS credential, displayed as hex
     * Users can compare fingerprints out-of-band to verify identity
     * @returns {string|null} 64-character hex fingerprint or null if not initialized
     */
    getIdentityFingerprint() {
        if (!this.client) return null;
        try {
            return this.client.get_identity_fingerprint();
        } catch (e) {
            console.error('[MLS] Error getting fingerprint:', e);
            return null;
        }
    }

    /**
     * Format a fingerprint for display (groups of 4 hex chars)
     * @param {string} fingerprint - 64-char hex string
     * @returns {string} Formatted fingerprint like "ABCD 1234 5678 ..."
     */
    formatFingerprint(fingerprint) {
        if (!fingerprint) return '';
        // Split into groups of 4 characters for readability
        return fingerprint.toUpperCase().match(/.{1,4}/g)?.join(' ') || fingerprint;
    }

    /**
     * Generate a numeric safety number (like Signal) for easier verbal comparison
     * @param {string} fingerprint - 64-char hex string
     * @returns {string} 60-digit number in groups of 5
     */
    fingerprintToNumeric(fingerprint) {
        if (!fingerprint) return '';
        // Convert hex to decimal digits (take first 60 chars, convert each hex pair to 2-digit number)
        const digits = [];
        for (let i = 0; i < Math.min(fingerprint.length, 60); i += 2) {
            const hexPair = fingerprint.substring(i, i + 2);
            const num = parseInt(hexPair, 16) % 100;
            digits.push(num.toString().padStart(2, '0'));
        }
        // Group into sets of 5 digits
        const numStr = digits.join('');
        return numStr.match(/.{1,5}/g)?.join(' ') || numStr;
    }

    /**
     * Wipe all in-memory cryptographic material
     * Called when locking the vault
     */
    wipeMemory() {
        this.cleanupSocketListeners();
        this.client = null;
        this.identityName = null;
        console.log('[MLS] Memory wiped');
    }
}

export default new CoreCryptoClient();
