import init, { MlsClient, init_logging } from 'openmls-wasm';
import { registerSocketEventHandler } from '../socket.js';
import { api } from '../api.js';

const KEY_PACKAGE_RENEWAL_WINDOW_SECONDS = 60 * 60 * 24 * 7;
const MAX_LEAF_NODE_LIFETIME_RANGE_SECONDS = (60 * 60 * 24 * 28 * 3) + (60 * 60);

/**
 * Core Crypto Client for OpenMLS integration
 * Handles WASM initialization and wraps the Rust MlsClient
 */
class CoreCryptoClient {
    constructor() {
        this.client = null;
        this.initialized = false;
        this.identityName = null;
        this.messageHandlers = []; // Callbacks for decrypted messages
        this.welcomeHandlers = []; // Callbacks for new group invites
        this.welcomeRequestHandlers = []; // Callbacks for welcome approval/inspection
        this.pendingWelcomes = new Map(); // messageId -> pending welcome payload
        this.confirmationTags = new Map(); // groupId -> Map(epoch -> tagHex)
        this.remoteConfirmationTags = new Map(); // groupId -> Map(epoch -> Set(tagHex))
        this.sentConfirmationTags = new Map(); // groupId -> Set(epoch)
        this.forkHandlers = []; // Callbacks for fork detection events
        this.commitRejectionHandlers = []; // Callbacks for commit/proposal rejection events
        this._socketCleanup = null;
        this.processedMessageIds = new Set(); // Track processed message IDs to prevent duplicates
        this.processingMessageIds = new Set();
        this.syncPromise = null;
    }

    /**
     * Initialize the WASM module and logging
     */
    async initialize() {
        if (this.initialized) return;

        try {
            await init();
            init_logging();
            this.initialized = true;
            console.log('OpenMLS WASM module initialized');
        } catch (error) {
            console.error('Failed to initialize OpenMLS WASM:', error);
            throw new Error('Crypto initialization failed');
        }
    }

    groupIdToBytes(groupId) {
        if (groupId instanceof Uint8Array) return groupId;
        if (ArrayBuffer.isView(groupId)) return new Uint8Array(groupId.buffer, groupId.byteOffset, groupId.byteLength);
        if (typeof groupId !== 'string') throw new Error('Invalid group ID');

        if (groupId.startsWith('dm_')) {
            return new TextEncoder().encode(groupId);
        }

        if (!/^[0-9a-f]+$/i.test(groupId) || groupId.length % 2 !== 0) {
            throw new Error('Invalid group ID format');
        }

        return new Uint8Array(groupId.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }

    groupIdFromBytes(groupIdBytes) {
        if (!groupIdBytes) return '';
        try {
            const text = new TextDecoder().decode(groupIdBytes);
            if (/^dm_\d+_\d+$/.test(text)) {
                return text;
            }
        } catch (e) {}
        return Array.from(groupIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    groupIdFromHex(groupIdHex) {
        if (!groupIdHex) return '';
        return this.groupIdFromBytes(this.hexToBytes(groupIdHex));
    }

    bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    hexToBytes(hex) {
        let normalized = hex;
        if (normalized.startsWith('\\x')) normalized = normalized.slice(2);
        return new Uint8Array(normalized.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }

    getDmParticipantIds(groupId) {
        if (!this.isDirectMessage(groupId)) return [];
        const parts = groupId.split('_');
        if (parts.length < 3) return [];
        return [parts[1], parts[2]].filter(Boolean);
    }

    isNumericIdentity(identity) {
        return typeof identity === 'string' && /^\\d+$/.test(identity);
    }

    buildAadPayload(groupId, epoch, type) {
        return {
            v: 1,
            groupId,
            epoch,
            type,
            ts: new Date().toISOString()
        };
    }

    encodeAad(payload) {
        return new TextEncoder().encode(JSON.stringify(payload));
    }

    parseAad(aadBytes) {
        if (!aadBytes || aadBytes.length === 0) return null;
        try {
            const text = new TextDecoder().decode(aadBytes);
            return JSON.parse(text);
        } catch (e) {
            return null;
        }
    }

    validateAad(aadBytes, expected) {
        const payload = this.parseAad(aadBytes);
        if (!payload) return { valid: false, reason: 'AAD missing or unparsable' };
        if (payload.groupId !== expected.groupId) {
            return { valid: false, reason: 'AAD groupId mismatch' };
        }
        if (payload.epoch !== expected.epoch) {
            return { valid: false, reason: 'AAD epoch mismatch' };
        }
        if (payload.type !== expected.type) {
            return { valid: false, reason: 'AAD type mismatch' };
        }
        return { valid: true, reason: null };
    }

    setGroupAad(groupId, type, epochOverride) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdValue = typeof groupId === 'string' ? groupId : this.groupIdFromBytes(groupId);
        const epoch = typeof epochOverride === 'number' ? epochOverride : this.getGroupEpoch(groupIdValue);
        const payload = this.buildAadPayload(groupIdValue, epoch, type);
        const aadBytes = this.encodeAad(payload);
        const groupIdBytes = this.groupIdToBytes(groupIdValue);
        this.client.set_group_aad(groupIdBytes, aadBytes);
        return payload;
    }

    // initDB removed - we rely on VaultService/Memory only

    /**
     * Save client state (No-op: Persistence is handled by VaultService)
     */
    async saveState() {
        // We do not save to unencrypted IndexedDB anymore.
        // State is exported via exportStateForVault and saved encrypted by VaultService.
        // We ensure granular events are drained from WASM memory to avoid buildup, but we drop them.
        try {
            if (this.client) {
                this.client.drain_storage_events(); 
            }
        } catch (e) {
            console.warn('[MLS] Failed to drain events:', e);
        }
    }

    /**
     * Load client state (No-op: Restoration is handled by VaultService)
     * @returns {boolean} Always false (force fresh start or vault restore)
     */
    async loadState(username) {
        // We rely on restoreStateFromVault.
        // Returning false ensures ensureMlsBootstrap creates a new identity if no vault is present.
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
            // Successfully loaded - ensure key packages are fresh and uploaded
            try {
                await this.ensureKeyPackagesFresh();
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
                const saved = await vaultService.saveCurrentState();
                if (saved) {
                    console.log('[MLS] New identity saved to vault');
                }
            } catch (vaultErr) {
                console.warn('[MLS] Could not save identity to vault:', vaultErr.message);
            }

            // Upload key package to server
            try {
                await this.ensureKeyPackagesFresh();
            } catch (uploadError) {
                console.warn('Failed to upload key package:', uploadError);
                // Continue even if upload fails - can retry later
            }

            // Note: Socket listeners should be set up explicitly after device registration
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

    getKeyPackageLifetimeInfo() {
        if (!this.client) throw new Error('Client not initialized');
        return this.client.get_key_package_lifetime();
    }

    getKeyPackageLifetimeInfoFromBytes(keyPackageBytes) {
        if (!this.client) throw new Error('Client not initialized');
        return this.client.key_package_lifetime_from_bytes(keyPackageBytes);
    }

    keyPackageExpiresSoon(lifetimeInfo) {
        if (!lifetimeInfo || typeof lifetimeInfo.not_after !== 'number') {
            return true;
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        return nowSeconds >= (lifetimeInfo.not_after - KEY_PACKAGE_RENEWAL_WINDOW_SECONDS);
    }

    keyPackageLifetimeAcceptable(lifetimeInfo) {
        if (!lifetimeInfo || typeof lifetimeInfo.range_seconds !== 'number') {
            return false;
        }
        if (lifetimeInfo.has_acceptable_range === false) {
            return false;
        }
        return lifetimeInfo.range_seconds <= MAX_LEAF_NODE_LIFETIME_RANGE_SECONDS;
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
     * @returns {Promise<Object>} Server response
     */
    async uploadKeyPackage(options = {}) {
        if (!this.client) throw new Error('Client not initialized');

        // Get token directly from localStorage to avoid circular import with auth.js
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            console.warn('[MLS] Skipping key package upload (device ID not set)');
            return null;
        }

        const { keyPackageBytes: providedBytes = null, isLastResort = false } = options;
        const keyPackageBytes = providedBytes || this.getKeyPackageBytes();
        const keyPackageHex = Array.from(keyPackageBytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        const hash = await this.computeHash(keyPackageBytes);
        const lifetimeInfo = providedBytes
            ? this.getKeyPackageLifetimeInfoFromBytes(keyPackageBytes)
            : this.getKeyPackageLifetimeInfo();

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
                hash,
                notBefore: lifetimeInfo?.not_before ?? null,
                notAfter: lifetimeInfo?.not_after ?? null,
                isLastResort
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

    async ensureKeyPackagesFresh() {
        if (!this.client) throw new Error('Client not initialized');

        let lifetimeInfo = null;
        try {
            lifetimeInfo = this.getKeyPackageLifetimeInfo();
        } catch (e) {
            console.warn('[MLS] Failed to read key package lifetime:', e);
        }

        let regenerated = false;
        if (!lifetimeInfo || !this.keyPackageLifetimeAcceptable(lifetimeInfo) || this.keyPackageExpiresSoon(lifetimeInfo)) {
            await this.regenerateKeyPackage();
            regenerated = true;
        } else {
            await this.uploadKeyPackage();
        }

        if (!regenerated) {
            await this.ensureLastResortKeyPackage();
        }
    }

    async ensureLastResortKeyPackage() {
        if (!this.client) throw new Error('Client not initialized');
        try {
            const lastResortBytes = this.client.generate_last_resort_key_package();
            await this.saveState();
            try {
                const vaultService = (await import('../vaultService.js')).default;
                await vaultService.saveCurrentState();
            } catch (e) {
                console.warn('[MLS] Failed to persist last-resort key package:', e);
            }
            await this.uploadKeyPackage({ keyPackageBytes: lastResortBytes, isLastResort: true });
        } catch (e) {
            console.warn('[MLS] Failed to generate last-resort key package:', e);
        }
    }

    /**
     * Fetch key packages for another user
     * @param {string|number} userId - The user ID to fetch
     * @param {boolean} fetchAll - Whether to fetch all device keys
     * @param {string|null} deviceId - Specific device ID to fetch
     * @returns {Promise<Uint8Array[]>} Array of key package bytes
     */
    async fetchKeyPackages(userId, fetchAll = false, deviceId = null) {
        if (!this.initialized) await this.initialize();

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        let url = `/api/mls/key-package/${userId}`;
        const params = new URLSearchParams();
        if (deviceId) params.set('deviceId', deviceId);
        else if (fetchAll) params.set('all', 'true');
        
        if (params.size > 0) url += `?${params.toString()}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch key packages');
        }

        const data = await response.json();
        const packages = Array.isArray(data) ? data : [data];

        const keyPackageBytes = packages.map(pkg => {
            if (!pkg.package_data) return null;
            
            // Handle Postgres bytea format
            if (pkg.package_data && pkg.package_data.type === 'Buffer' && Array.isArray(pkg.package_data.data)) {
                return new Uint8Array(pkg.package_data.data);
            } else if (typeof pkg.package_data === 'string') {
                let hex = pkg.package_data;
                if (hex.startsWith('\\x')) hex = hex.substring(2);
                return new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            }
            return null;
        }).filter(Boolean);

        return keyPackageBytes.filter(bytes => {
            try {
                const lifetimeInfo = this.getKeyPackageLifetimeInfoFromBytes(bytes);
                return this.keyPackageLifetimeAcceptable(lifetimeInfo);
            } catch (e) {
                console.warn('[MLS] Skipping key package with invalid lifetime:', e);
                return false;
            }
        });
    }

    /**
     * Create a new MLS group
     * @param {string} name - Human readable group name
     * @returns {Promise<Object>} Created group metadata
     */
    async createGroup(name, options = {}) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized (Identity not found)');

        // Generate a random group ID (16 bytes as hex string)
        const groupIdBytes = new Uint8Array(16);
        crypto.getRandomValues(groupIdBytes);
        const groupId = Array.from(groupIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        try {
            const externalSenders = Array.isArray(options.externalSenders) ? options.externalSenders : [];
            let groupState;

            if (externalSenders.length > 0 && this.client.create_group_with_external_senders) {
                const identities = [];
                const signatureKeys = [];
                for (const sender of externalSenders) {
                    if (!sender || typeof sender.identity !== 'string' || !sender.signatureKey) {
                        throw new Error('External sender requires { identity, signatureKey }');
                    }
                    identities.push(sender.identity);
                    if (sender.signatureKey instanceof Uint8Array) {
                        signatureKeys.push(sender.signatureKey);
                    } else if (typeof sender.signatureKey === 'string') {
                        signatureKeys.push(this.hexToBytes(sender.signatureKey));
                    } else if (Array.isArray(sender.signatureKey)) {
                        signatureKeys.push(new Uint8Array(sender.signatureKey));
                    } else {
                        throw new Error('External sender signatureKey must be Uint8Array, hex string, or byte array');
                    }
                }
                groupState = this.client.create_group_with_external_senders(groupIdBytes, identities, signatureKeys);
            } else {
                // Call WASM to create the group state
                // WASM expects raw bytes, not hex string
                groupState = this.client.create_group(groupIdBytes);
            }
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

            try {
                await this.syncGroupMembers(groupId);
            } catch (syncErr) {
                console.warn('[MLS] Failed to sync group members:', syncErr);
            }

            return groupData;
        } catch (e) {
            console.error('Error creating group:', e);
            throw e;
        }
    }

    exportGroupInfo(groupId, { includeRatchetTree = true } = {}) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        const infoBytes = this.client.export_group_info(groupIdBytes, includeRatchetTree);
        return infoBytes instanceof Uint8Array ? infoBytes : new Uint8Array(infoBytes);
    }

    inspectGroupInfo(groupInfoBytes) {
        if (!this.client) throw new Error('Client not initialized');
        const summary = this.client.inspect_group_info(groupInfoBytes);
        return {
            groupIdHex: summary.group_id_hex,
            groupId: this.groupIdFromHex(summary.group_id_hex),
            epoch: typeof summary.epoch === 'bigint' ? Number(summary.epoch) : summary.epoch,
            ciphersuite: summary.ciphersuite,
            hasRatchetTree: summary.has_ratchet_tree,
            hasExternalPub: summary.has_external_pub
        };
    }

    async publishGroupInfo(groupId, { includeRatchetTree = true, isPublic = false } = {}) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupInfoBytes = this.exportGroupInfo(groupId, { includeRatchetTree });
        const infoMeta = this.inspectGroupInfo(groupInfoBytes);
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const response = await fetch(`/api/mls/groups/${encodeURIComponent(groupId)}/group-info`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                groupInfo: '\\x' + this.bytesToHex(groupInfoBytes),
                epoch: infoMeta.epoch,
                isPublic: !!isPublic
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to publish group info');
        }

        return await response.json();
    }

    async fetchGroupInfo(groupId) {
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const response = await fetch(`/api/mls/groups/${encodeURIComponent(groupId)}/group-info`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to fetch group info');
        }

        const payload = await response.json();
        if (!payload?.groupInfo) {
            throw new Error('Group info not available');
        }

        let groupInfoBytes;
        if (payload.groupInfo.type === 'Buffer' && Array.isArray(payload.groupInfo.data)) {
            groupInfoBytes = new Uint8Array(payload.groupInfo.data);
        } else if (typeof payload.groupInfo === 'string' && payload.groupInfo.startsWith('\\x')) {
            groupInfoBytes = this.hexToBytes(payload.groupInfo);
        } else if (payload.groupInfo instanceof Uint8Array) {
            groupInfoBytes = payload.groupInfo;
        } else if (Array.isArray(payload.groupInfo)) {
            groupInfoBytes = new Uint8Array(payload.groupInfo);
        } else {
            throw new Error('Unsupported group info format');
        }

        return {
            groupInfoBytes,
            epoch: payload.epoch
        };
    }

    async joinGroupByExternalCommit({ groupInfoBytes, ratchetTreeBytes = null, pskIds = [] }) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const infoMeta = this.inspectGroupInfo(groupInfoBytes);
        const groupId = infoMeta.groupId;
        const aadPayload = this.buildAadPayload(groupId, infoMeta.epoch, 'commit');
        const aadBytes = this.encodeAad(aadPayload);

        const pskArray = Array.isArray(pskIds) ? pskIds : [pskIds];
        const pskIdArray = pskArray.map(psk => {
            if (psk instanceof Uint8Array) return psk;
            if (typeof psk === 'string') return this.hexToBytes(psk);
            if (Array.isArray(psk)) return new Uint8Array(psk);
            throw new Error('PSK ID must be Uint8Array, hex string, or byte array');
        });

        const result = this.client.join_by_external_commit(
            groupInfoBytes,
            ratchetTreeBytes,
            pskIdArray,
            aadBytes
        );

        const commitBytes = new Uint8Array(result.commit || []);
        const commitEpoch = typeof result.epoch === 'bigint' ? Number(result.epoch) : result.epoch;
        const finalGroupId = this.groupIdFromHex(result.group_id_hex || infoMeta.groupIdHex);

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        const commitResponse = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId: finalGroupId,
                epoch: commitEpoch ?? infoMeta.epoch,
                messageType: 'commit',
                data: '\\x' + this.bytesToHex(commitBytes)
            })
        });

        if (!commitResponse.ok) {
            const error = await commitResponse.json().catch(() => ({}));
            try {
                this.removeGroup(finalGroupId);
            } catch (removeErr) {
                console.warn('[MLS] Failed to remove external commit group after rejection:', removeErr);
            }
            throw new Error(error.error || 'Failed to send external commit');
        }

        await this.saveState();

        try {
            await vaultService.saveCurrentState();
        } catch (vaultErr) {
            console.warn('[MLS] Could not save external commit state to vault:', vaultErr.message);
        }

        try {
            await this.syncGroupMembers(finalGroupId);
        } catch (syncErr) {
            console.warn('[MLS] Failed to sync group members after external commit:', syncErr);
        }

        // Broadcast confirmation tag for fork detection
        try {
            const currentEpoch = this.getGroupEpoch(finalGroupId);
            await this.broadcastConfirmationTag(finalGroupId, currentEpoch);
        } catch (tagErr) {
            console.warn('[MLS] Failed to broadcast confirmation tag after external commit:', tagErr);
        }

        return {
            groupId: finalGroupId,
            commitEpoch: commitEpoch ?? infoMeta.epoch
        };
    }

    createExternalPsk(pskIdHex = '') {
        if (!this.client) throw new Error('Client not initialized');
        const pskIdBytes = pskIdHex ? this.hexToBytes(pskIdHex) : new Uint8Array();
        const bundle = this.client.generate_external_psk(pskIdBytes);
        const pskIdSerialized = new Uint8Array(bundle.psk_id_serialized || []);
        return {
            pskId: this.bytesToHex(new Uint8Array(bundle.psk_id || [])),
            pskNonce: this.bytesToHex(new Uint8Array(bundle.psk_nonce || [])),
            pskIdSerialized,
            secret: new Uint8Array(bundle.secret || [])
        };
    }

    storeExternalPsk(pskIdSerialized, secretBytes) {
        if (!this.client) throw new Error('Client not initialized');
        const pskIdBytes = pskIdSerialized instanceof Uint8Array
            ? pskIdSerialized
            : this.hexToBytes(pskIdSerialized);
        const secret = secretBytes instanceof Uint8Array
            ? secretBytes
            : this.hexToBytes(secretBytes);
        this.client.store_external_psk(pskIdBytes, secret);
    }

    async proposeExternalPsk(groupId, pskIdSerialized) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        const pskIdBytes = pskIdSerialized instanceof Uint8Array
            ? pskIdSerialized
            : this.hexToBytes(pskIdSerialized);

        this.setGroupAad(groupId, 'proposal');
        const proposalBytes = this.client.propose_external_psk(groupIdBytes, pskIdBytes);
        const proposalHex = this.bytesToHex(proposalBytes);

        const response = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId,
                messageType: 'proposal',
                data: '\\x' + proposalHex
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to send PSK proposal');
        }

        await this.saveState();
        return await response.json();
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
                const groupIdBytes = this.groupIdToBytes(groupId);
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

    getGroupEpoch(groupId) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        const epoch = this.client.get_group_epoch(groupIdBytes);
        if (typeof epoch === 'bigint') {
            return Number(epoch);
        }
        return epoch;
    }

    getGroupMemberIdentities(groupId) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        const identities = this.client.get_group_member_identities(groupIdBytes);
        return Array.from(identities || []).filter(Boolean);
    }

    getGroupMembers(groupId) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        return this.client.get_group_members(groupIdBytes) || [];
    }

    async syncGroupMembers(groupId) {
        const identities = this.getGroupMemberIdentities(groupId);
        const memberIds = identities
            .filter(id => this.isNumericIdentity(id))
            .map(id => Number(id));

        if (memberIds.length === 0) return;

        await api.mls.syncGroupMembers(groupId, memberIds);
    }

    /**
     * Invite a user (all their devices or a specific one) to a group
     * @param {string} groupId - The Group ID
     * @param {string|number} userId - The User ID to invite
     * @param {string|null} targetDeviceId - Optional specific device ID to invite
     * @returns {Promise<Object>} Success status
     */
    async inviteToGroup(groupId, userId, targetDeviceId = null) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        try {
            // 1. Fetch Key Packages (all or specific)
            const keyPackages = await this.fetchKeyPackages(userId, true, targetDeviceId);
            console.log(`Fetched ${keyPackages.length} key packages for user ${userId} (targetDevice: ${targetDeviceId || 'all'})`);

            if (keyPackages.length === 0) {
                throw new Error('No key packages found for user');
            }

            const token = localStorage.getItem('token');
            const { default: vaultService } = await import('../vaultService.js');
            const deviceId = vaultService.getDeviceId();
            if (!deviceId) {
                throw new Error('Device ID not available. Unlock or set up your keystore first.');
            }
            
            // Helper to convert to hex
            const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
            const groupIdBytes = this.groupIdToBytes(groupId);

            // 2. Iterate and add each device
            let addedCount = 0;
            for (const keyPackageBytes of keyPackages) {
                try {
                    const rollbackState = await this.exportStateForVault();
                    this.setGroupAad(groupId, 'commit');
                    // 3. Add member in WASM (creates Proposal + Commit + Welcome)
                    const result = this.client.add_member(groupIdBytes, keyPackageBytes);
                    
                    if (!result || !Array.isArray(result) || result.length < 2) {
                        console.warn('Failed to generate commit/welcome for a device, skipping');
                        continue;
                    }

                    const welcomeBytes = result[0];
                    const commitBytes = result[1];
                    const groupInfoBytes = result.length > 2 ? result[2] : null;
                    const epoch = this.getGroupEpoch(groupId);

                    // 4. Upload Commit Message (existing members only)
                    // OpenMLS Book: commit goes to existing members; welcome goes to new members.
                    const commitResponse = await fetch('/api/mls/messages/group', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                            'x-device-id': deviceId
                        },
                        body: JSON.stringify({
                            groupId,
                            epoch,
                            messageType: 'commit',
                            data: '\\x' + toHex(commitBytes),
                            excludeUserIds: [userId]
                        })
                    });

                    if (!commitResponse.ok) {
                        const error = await commitResponse.json().catch(() => ({}));
                        try {
                            this.client.clear_pending_commit(groupIdBytes);
                        } catch (clearErr) {
                            console.warn('[MLS] Failed to clear pending commit after rejection:', clearErr);
                        }
                        // Roll back local state if the delivery service rejected the commit
                        if (rollbackState) {
                            await this.restoreStateFromVault(rollbackState);
                        }
                        throw new Error(error.error || 'Failed to send commit message');
                    }

                    try {
                        this.client.merge_pending_commit(groupIdBytes);
                    } catch (mergeErr) {
                        console.warn('[MLS] Failed to merge pending commit:', mergeErr);
                        throw mergeErr;
                    }

                    try {
                        const currentEpoch = this.getGroupEpoch(groupId);
                        await this.broadcastConfirmationTag(groupId, currentEpoch);
                    } catch (tagErr) {
                        console.warn('[MLS] Failed to broadcast confirmation tag:', tagErr);
                    }

                    // 5. Upload Welcome Message (new members only, after commit accepted)
                    const welcomeResponse = await fetch('/api/mls/messages/welcome', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                            'x-device-id': deviceId
                        },
                        body: JSON.stringify({
                            groupId,
                            receiverId: userId,
                            data: '\\x' + toHex(welcomeBytes),
                            groupInfo: groupInfoBytes ? ('\\x' + toHex(groupInfoBytes)) : null
                        })
                    });

                    if (!welcomeResponse.ok) {
                        const error = await welcomeResponse.json().catch(() => ({}));
                        throw new Error(error.error || 'Failed to send welcome message');
                    }

                    addedCount++;
                    
                    // Save state after EACH member add to persist the new epoch
                    await this.saveState();
                    try {
                        const vaultService = (await import('../vaultService.js')).default;
                        await vaultService.saveCurrentState();
                    } catch (e) {}
                    try {
                        await this.syncGroupMembers(groupId);
                    } catch (syncErr) {
                        console.warn('[MLS] Failed to sync group members:', syncErr);
                    }

                } catch (e) {
                    console.warn(`Failed to add a device for user ${userId}:`, e);
                    // Continue to try other devices
                }
            }

            if (addedCount > 0) {
                return { success: true, devicesAdded: addedCount };
            }
            throw new Error('Failed to add any devices for user');

        } catch (e) {
            console.error('Error inviting user:', e);
            throw e;
        }
    }

    async recoverForkByReadding(groupId, ownLeafIndices, keyPackageBytesList) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const indices = Array.isArray(ownLeafIndices) ? ownLeafIndices : [ownLeafIndices];
        const keyPackages = Array.isArray(keyPackageBytesList) ? keyPackageBytesList : [keyPackageBytesList];

        this.setGroupAad(groupId, 'commit');

        const result = this.client.recover_fork_by_readding(groupIdBytes, indices, keyPackages);
        return {
            groupId: groupId,
            commitBytes: new Uint8Array(result.commit || []),
            welcomeBytes: result.welcome ? new Uint8Array(result.welcome) : null,
            groupInfoBytes: result.group_info ? new Uint8Array(result.group_info) : null
        };
    }

    async rebootGroup(groupId, newGroupId, keyPackageBytesList) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const newGroupIdBytes = this.groupIdToBytes(newGroupId);
        const keyPackages = Array.isArray(keyPackageBytesList) ? keyPackageBytesList : [keyPackageBytesList];
        const aadPayload = this.buildAadPayload(newGroupId, 0, 'commit');
        const aadBytes = this.encodeAad(aadPayload);

        const result = this.client.reboot_group(groupIdBytes, newGroupIdBytes, keyPackages, aadBytes);
        return {
            groupId: newGroupId,
            commitBytes: new Uint8Array(result.commit || []),
            welcomeBytes: result.welcome ? new Uint8Array(result.welcome) : null,
            groupInfoBytes: result.group_info ? new Uint8Array(result.group_info) : null
        };
    }

    removeGroup(groupId) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        this.client.remove_group(groupIdBytes);
    }

    /**
     * Join a group from a Welcome message
     * Routes through two-phase validation for security
     * @param {Uint8Array} welcomeBytes
     * @param {Uint8Array|null} ratchetTreeBytes - Optional ratchet tree
     * @returns {Promise<string>} Group ID (hex)
     */
    async joinGroup(welcomeBytes, ratchetTreeBytes = null) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        // Route through two-phase validation flow
        const staged = await this.stageWelcome(welcomeBytes, ratchetTreeBytes);
        const validation = this.validateStagedWelcomeMembers(staged.stagingId);

        if (!validation.valid) {
            this.rejectStagedWelcome(staged.stagingId);
            throw new Error(`Welcome validation failed: ${validation.issues.join(', ')}`);
        }

        // Accept and join via the validated path
        const groupId = await this.acceptStagedWelcome(staged.stagingId);
        console.log('[MLS] Joined group via two-phase validation:', groupId);

        return groupId;
    }

    // ===== TWO-PHASE JOIN (with credential validation) =====

    /**
     * Stage a welcome for inspection before joining (two-phase join)
     * Per OpenMLS Book (p.17-21): Validate credentials before accepting
     * @param {Uint8Array} welcomeBytes - The welcome message bytes
     * @param {Uint8Array|null} ratchetTreeBytes - Optional ratchet tree
     * @returns {Promise<Object>} Staging info with stagingId and member details
     */
    async stageWelcome(welcomeBytes, ratchetTreeBytes = null) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        // Stage the welcome in WASM
        const stagingId = this.client.stage_welcome(welcomeBytes, ratchetTreeBytes);

        // Get the inspection info
        const info = this.client.get_staged_welcome_info(stagingId);
        const groupId = this.groupIdFromHex(info.group_id_hex);

        console.log('[MLS] Welcome staged for inspection:', stagingId);
        console.log('[MLS] Group members:', info.members?.length || 0);

        return {
            stagingId,
            groupId,
            ciphersuite: info.ciphersuite,
            epoch: info.epoch,
            sender: info.sender,
            members: info.members
        };
    }

    /**
     * Get info about a staged welcome
     * @param {string} stagingId - The staging ID from stageWelcome
     * @returns {Object} Welcome info with sender and members
     */
    getStagedWelcomeInfo(stagingId) {
        if (!this.client) throw new Error('Client not initialized');
        return this.client.get_staged_welcome_info(stagingId);
    }

    /**
     * Accept a staged welcome and join the group
     * Call this after inspecting and approving the welcome
     * @param {string} stagingId - The staging ID from stageWelcome
     * @returns {Promise<string>} Group ID (hex)
     */
    async acceptStagedWelcome(stagingId) {
        if (!this.client) throw new Error('Client not initialized');

        // Accept and join in WASM
        const groupIdBytes = this.client.accept_staged_welcome(stagingId);
        const groupId = this.groupIdFromBytes(groupIdBytes);

        console.log('[MLS] Accepted staged welcome, joined group:', groupId);

        // Save state
        await this.saveState();

        // Regenerate KeyPackage (it was consumed)
        await this.regenerateKeyPackage();

        // Save to vault
        try {
            const vaultService = (await import('../vaultService.js')).default;
            await vaultService.saveCurrentState();
        } catch (e) {
            console.warn('[MLS] Could not save to vault:', e.message);
        }

        // Sync members
        try {
            await this.syncGroupMembers(groupId);
        } catch (e) {
            console.warn('[MLS] Failed to sync group members:', e);
        }

        try {
            const currentEpoch = this.getGroupEpoch(groupId);
            await this.broadcastConfirmationTag(groupId, currentEpoch);
        } catch (tagErr) {
            console.warn('[MLS] Failed to broadcast confirmation tag:', tagErr);
        }

        return groupId;
    }

    /**
     * Reject a staged welcome (discard without joining)
     * @param {string} stagingId - The staging ID from stageWelcome
     */
    rejectStagedWelcome(stagingId) {
        if (!this.client) throw new Error('Client not initialized');
        this.client.reject_staged_welcome(stagingId);
        console.log('[MLS] Rejected staged welcome:', stagingId);
    }

    /**
     * List all pending staged welcomes
     * @returns {string[]} Array of staging IDs
     */
    listStagedWelcomes() {
        if (!this.client) return [];
        return Array.from(this.client.list_staged_welcomes() || []);
    }

    /**
     * Validate members of a staged welcome against a policy
     * @param {string} stagingId - The staging ID
     * @param {Function} validator - Function(member) => boolean, return false to reject
     * @returns {Object} { valid: boolean, invalidMembers: [] }
     */
    validateStagedWelcomeMembers(stagingId, validator) {
        const info = this.getStagedWelcomeInfo(stagingId);
        const groupId = this.groupIdFromHex(info.group_id_hex);
        console.log('[MLS] validateStagedWelcomeMembers:', { groupId, members: info.members, sender: info.sender });
        const invalidMembers = [];
        const issues = [];
        const defaultValidator = (member) => {
            console.log('[MLS] Validating member:', JSON.stringify(member));
            if (!member || !member.is_basic_credential) {
                console.log('[MLS] Member rejected: missing or not basic credential');
                return false;
            }
            if (member.lifetime && !this.keyPackageLifetimeAcceptable(member.lifetime)) {
                return false;
            }
            if (this.isDirectMessage(groupId)) {
                const allowed = new Set(this.getDmParticipantIds(groupId));
                // Convert identity to string for comparison (getDmParticipantIds returns strings)
                return allowed.has(String(member.identity));
            }
            return this.isNumericIdentity(member.identity);
        };
        const validateMember = typeof validator === 'function' ? validator : defaultValidator;

        for (const member of info.members || []) {
            if (!validateMember(member)) {
                invalidMembers.push(member);
                issues.push(`Invalid member credential: ${member.identity || 'unknown'}`);
            }
        }

        if (info.sender && !validateMember({
            identity: info.sender.identity,
            is_basic_credential: info.sender.is_basic_credential,
            lifetime: info.sender.lifetime
        })) {
            issues.push(`Invalid sender credential: ${info.sender.identity || 'unknown'}`);
        }

        return {
            valid: invalidMembers.length === 0 && issues.length === 0,
            invalidMembers,
            issues,
            groupId
        };
    }

    // ===== END TWO-PHASE JOIN =====

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

        // Save updated state (drains events)
        await this.saveState();

        // CRITICAL: Save to vault so new private key is persisted
        try {
            const vaultService = (await import('../vaultService.js')).default;
            await vaultService.saveCurrentState();
            console.log('[MLS] New KeyPackage state saved to vault');
        } catch (e) {
            console.warn('[MLS] Failed to save new KeyPackage to vault:', e);
        }

        // Upload new KeyPackage to server
        try {
            await this.uploadKeyPackage();
            console.log('[MLS] New KeyPackage uploaded to server');
        } catch (e) {
            console.warn('[MLS] Failed to upload new KeyPackage:', e);
        }

        try {
            await this.ensureLastResortKeyPackage();
        } catch (e) {
            console.warn('[MLS] Failed to refresh last-resort key package:', e);
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

        // Convert groupId to bytes for MLS operations
        const groupIdBytes = this.groupIdToBytes(groupId);

        // Convert plaintext to bytes
        const encoder = new TextEncoder();
        const plaintextBytes = encoder.encode(plaintext);

        // Bind AAD metadata for this application message
        this.setGroupAad(groupId, 'application');

        // Encrypt the message using WASM
        const ciphertextBytes = this.client.encrypt_message(groupIdBytes, plaintextBytes);
        console.log(`[MLS] Encrypted message: ${plaintextBytes.length} bytes -> ${ciphertextBytes.length} bytes`);

        // Convert to hex for PostgreSQL bytea storage
        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
        const ciphertextHex = '\\x' + toHex(ciphertextBytes);
        const groupIdValue = typeof groupId === 'string' ? groupId : this.groupIdFromBytes(groupIdBytes);

        // Send to server
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        const response = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId: groupIdValue,
                messageType: 'application',
                data: ciphertextHex
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            console.error('[MLS] Send message failed:', response.status, error);
            throw new Error(error.error || 'Failed to send message');
        }

        const result = await response.json();
        const messageId = result.queueId || result.id; // Handle both just in case
        console.log('[MLS] Message sent:', messageId);

        // Store plaintext for own message history (can't decrypt own messages in MLS)
        try {
            this.client.store_sent_message(groupIdBytes, String(messageId), plaintext);
            console.log('[MLS] Stored sent message for history:', messageId);
            
            // Save state to persist sent message
            const vaultService = (await import('../vaultService.js')).default;
            await vaultService.saveCurrentState();
            
            // Persist message history
            await vaultService.persistMessage({
                id: messageId,
                groupId: groupIdValue,
                senderId: this.identityName || localStorage.getItem('userId'), // We are the sender
                plaintext,
                type: 'application',
                timestamp: new Date().toISOString()
            });
            
        } catch (e) {
            console.warn('[MLS] Failed to store sent message:', e);
        }

        return { ...result, id: messageId };
    }

    /**
     * Send an internal MLS system message (not stored in user history)
     * @param {Uint8Array|string} groupId - The group ID
     * @param {Object|string} payload - JSON payload or plaintext string
     * @returns {Promise<Object>} Server response with message ID
     */
    async sendSystemMessage(groupId, payload) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const groupIdValue = typeof groupId === 'string' ? groupId : this.groupIdFromBytes(groupIdBytes);

        const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const encoder = new TextEncoder();
        const plaintextBytes = encoder.encode(plaintext);

        // Bind AAD metadata for this application message
        this.setGroupAad(groupIdValue, 'application');

        const ciphertextBytes = this.client.encrypt_message(groupIdBytes, plaintextBytes);
        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
        const ciphertextHex = '\\x' + toHex(ciphertextBytes);

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        const response = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId: groupIdValue,
                messageType: 'application',
                data: ciphertextHex
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            console.error('[MLS] System message send failed:', response.status, error);
            throw new Error(error.error || 'Failed to send system message');
        }

        return await response.json();
    }

    /**
     * Perform key rotation (self-update) for Post-Compromise Security
     * Per OpenMLS Book (p.36-38 "Updating own leaf node")
     * This generates fresh HPKE encryption keys and broadcasts a commit to the group.
     * Should be called periodically or after suspected compromise.
     * @param {Uint8Array|string} groupId - The group ID
     * @returns {Promise<Object>} Server response
     */
    async selfUpdate(groupId) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const groupIdValue = typeof groupId === 'string' ? groupId : this.groupIdFromBytes(groupIdBytes);

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        // Helper to convert to hex
        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');

        // Capture state for rollback
        const rollbackState = await this.exportStateForVault();

        this.setGroupAad(groupIdValue, 'commit');

        // Call WASM self_update - returns [commit, optional_welcome, optional_group_info]
        const result = this.client.self_update(groupIdBytes);

        if (!result || result.length < 1) {
            throw new Error('self_update returned invalid result');
        }

        const commitBytes = result[0];
        const welcomeBytes = result[1]; // May be null
        const epoch = this.getGroupEpoch(groupId);

        // Send commit to server
        const commitResponse = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId: groupIdValue,
                epoch,
                messageType: 'commit',
                data: '\\x' + toHex(commitBytes)
            })
        });

        if (!commitResponse.ok) {
            const error = await commitResponse.json().catch(() => ({}));
            // Clear pending commit on failure
            try {
                this.client.clear_pending_commit(groupIdBytes);
            } catch (clearErr) {
                console.warn('[MLS] Failed to clear pending commit:', clearErr);
            }
            // Rollback
            if (rollbackState) {
                await this.restoreStateFromVault(rollbackState);
            }
            throw new Error(error.error || 'Failed to send self-update commit');
        }

        // Merge the pending commit locally
        try {
            this.client.merge_pending_commit(groupIdBytes);
        } catch (mergeErr) {
            console.warn('[MLS] Failed to merge pending commit:', mergeErr);
            throw mergeErr;
        }

        // Save updated state
        await this.saveState();
        console.log('[MLS] Self-update complete - keys rotated for PCS');

        try {
            const currentEpoch = this.getGroupEpoch(groupIdValue);
            await this.broadcastConfirmationTag(groupIdValue, currentEpoch);
        } catch (tagErr) {
            console.warn('[MLS] Failed to broadcast confirmation tag:', tagErr);
        }

        return await commitResponse.json();
    }

    /**
     * Remove a member from a group
     * Per OpenMLS Book (p.31-32 "Removing members from a group")
     * @param {Uint8Array|string} groupId - The group ID
     * @param {number} leafIndex - The leaf index of the member to remove
     * @returns {Promise<Object>} Server response
     */
    async removeMember(groupId, leafIndex) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const groupIdValue = typeof groupId === 'string' ? groupId : this.groupIdFromBytes(groupIdBytes);

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        // Helper to convert to hex
        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');

        // Capture state for rollback
        const rollbackState = await this.exportStateForVault();

        this.setGroupAad(groupIdValue, 'commit');

        // Call WASM remove_member - returns [commit, optional_welcome, optional_group_info]
        const result = this.client.remove_member(groupIdBytes, leafIndex);

        if (!result || result.length < 1) {
            throw new Error('remove_member returned invalid result');
        }

        const commitBytes = result[0];
        const epoch = this.getGroupEpoch(groupId);

        // Send commit to server
        const commitResponse = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId: groupIdValue,
                epoch,
                messageType: 'commit',
                data: '\\x' + toHex(commitBytes)
            })
        });

        if (!commitResponse.ok) {
            const error = await commitResponse.json().catch(() => ({}));
            try {
                this.client.clear_pending_commit(groupIdBytes);
            } catch (clearErr) {
                console.warn('[MLS] Failed to clear pending commit:', clearErr);
            }
            if (rollbackState) {
                await this.restoreStateFromVault(rollbackState);
            }
            throw new Error(error.error || 'Failed to send remove-member commit');
        }

        // Merge the pending commit locally
        try {
            this.client.merge_pending_commit(groupIdBytes);
        } catch (mergeErr) {
            console.warn('[MLS] Failed to merge pending commit:', mergeErr);
            throw mergeErr;
        }

        // Sync server-side membership
        await this.syncGroupMembers(groupIdValue);

        // Save updated state
        await this.saveState();
        console.log(`[MLS] Member at leaf index ${leafIndex} removed from group`);

        try {
            const currentEpoch = this.getGroupEpoch(groupIdValue);
            await this.broadcastConfirmationTag(groupIdValue, currentEpoch);
        } catch (tagErr) {
            console.warn('[MLS] Failed to broadcast confirmation tag:', tagErr);
        }

        return await commitResponse.json();
    }

    /**
     * Leave a group voluntarily
     * Per OpenMLS Book (p.40 "Leaving a group")
     * Creates a self-remove proposal that another member must commit.
     * @param {Uint8Array|string} groupId - The group ID
     * @returns {Promise<Object>} Server response
     */
    async leaveGroup(groupId) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const groupIdValue = typeof groupId === 'string' ? groupId : this.groupIdFromBytes(groupIdBytes);

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        // Helper to convert to hex
        const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');

        // Call WASM leave_group - returns proposal bytes (NOT a commit)
        this.setGroupAad(groupIdValue, 'proposal');
        const proposalBytes = this.client.leave_group(groupIdBytes);

        // Send proposal to server (messageType = 'proposal' or relay as-is)
        // Note: This is a proposal, not a commit. Another member must commit it.
        const response = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId: groupIdValue,
                messageType: 'proposal',
                data: '\\x' + toHex(proposalBytes)
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Failed to send leave-group proposal');
        }

        console.log('[MLS] Leave-group proposal sent. Awaiting commit by another member.');

        // Note: We don't mark the group as inactive yet - that happens when we process
        // the commit that includes our removal proposal.
        await this.saveState();

        return await response.json();
    }

    /**
     * Get own leaf index in a group
     * Useful for UI to prevent users from trying to remove themselves via removeMember
     * @param {Uint8Array|string} groupId - The group ID
     * @returns {number} The leaf index
     */
    getOwnLeafIndex(groupId) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        return this.client.get_own_leaf_index(groupIdBytes);
    }

    getGroupConfirmationTag(groupId) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        const tagBytes = this.client.get_group_confirmation_tag(groupIdBytes);
        return this.bytesToHex(tagBytes);
    }

    recordLocalConfirmationTag(groupId, epoch, tagHex) {
        if (!groupId || typeof epoch !== 'number' || !tagHex) return;
        if (!this.confirmationTags.has(groupId)) {
            this.confirmationTags.set(groupId, new Map());
        }
        const epochMap = this.confirmationTags.get(groupId);
        epochMap.set(epoch, tagHex);

        const remoteEpochMap = this.remoteConfirmationTags.get(groupId);
        const remoteTags = remoteEpochMap?.get(epoch);
        if (remoteTags) {
            for (const remoteTag of remoteTags) {
                if (remoteTag !== tagHex) {
                    this.emitForkDetected({
                        groupId,
                        epoch,
                        localTag: tagHex,
                        remoteTag,
                        reason: 'confirmation_tag_mismatch'
                    });
                    break;
                }
            }
        }
    }

    recordRemoteConfirmationTag(groupId, epoch, tagHex, senderId) {
        if (!groupId || typeof epoch !== 'number' || !tagHex) return;
        if (!this.remoteConfirmationTags.has(groupId)) {
            this.remoteConfirmationTags.set(groupId, new Map());
        }
        const epochMap = this.remoteConfirmationTags.get(groupId);
        if (!epochMap.has(epoch)) {
            epochMap.set(epoch, new Set());
        }
        const tagSet = epochMap.get(epoch);
        tagSet.add(tagHex);

        if (tagSet.size > 1) {
            this.emitForkDetected({
                groupId,
                epoch,
                localTag: this.confirmationTags.get(groupId)?.get(epoch) || null,
                remoteTag: tagHex,
                reason: 'remote_tag_mismatch',
                senderId
            });
        }

        const localTag = this.confirmationTags.get(groupId)?.get(epoch);
        if (localTag && localTag !== tagHex) {
            this.emitForkDetected({
                groupId,
                epoch,
                localTag,
                remoteTag: tagHex,
                reason: 'confirmation_tag_mismatch',
                senderId
            });
        }
    }

    async broadcastConfirmationTag(groupId, epoch) {
        if (!this.client || typeof epoch !== 'number') return;
        const epochSet = this.sentConfirmationTags.get(groupId) || new Set();
        if (epochSet.has(epoch)) return;

        const tagHex = this.getGroupConfirmationTag(groupId);
        this.recordLocalConfirmationTag(groupId, epoch, tagHex);
        epochSet.add(epoch);
        this.sentConfirmationTags.set(groupId, epochSet);

        await this.sendSystemMessage(groupId, {
            __mls_type: 'confirmation_tag',
            epoch,
            tag_hex: tagHex
        });
    }

    async handleConfirmationTagMessage(groupId, payload, senderId) {
        if (!payload || typeof payload.epoch !== 'number' || !payload.tag_hex) {
            return;
        }
        this.recordRemoteConfirmationTag(groupId, payload.epoch, payload.tag_hex, senderId);
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

        const groupIdBytes = this.groupIdToBytes(groupId);

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

        const result = this.client.decrypt_message_with_aad(groupIdBytes, ciphertextBytes);
        const plaintextBytes = new Uint8Array(result.plaintext || []);
        const aadHex = result.aad_hex || '';
        const aadBytes = aadHex ? this.hexToBytes(aadHex) : new Uint8Array();
        const epoch = typeof result.epoch === 'bigint' ? Number(result.epoch) : result.epoch;

        const decoder = new TextDecoder();
        const plaintext = decoder.decode(plaintextBytes);
        console.log(`[MLS] Decrypted message: ${ciphertextBytes.length} bytes -> "${plaintext}"`);

        return {
            plaintext,
            aadBytes,
            aadHex,
            epoch
        };
    }

    /**
     * Unified message sync - polls relay queue and processes all pending messages
     */
    async syncMessages() {
        if (this.syncPromise) return this.syncPromise;
        this.syncPromise = this._syncMessagesInternal();
        try {
            return await this.syncPromise;
        } finally {
            this.syncPromise = null;
        }
    }

    async _syncMessagesInternal() {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) return [];

        // Import vaultService dynamically to avoid circular deps
        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            console.log('[MLS] Device ID not available yet, skipping sync');
            return [];
        }

        try {
            const pending = await api.mls.getPendingMessages();
            if (!pending || pending.length === 0) return [];

            console.log(`[MLS] Syncing ${pending.length} messages from relay queue`);

            const processedIds = [];
            for (const msg of pending) {
                const messageId = msg.id;
                if (messageId && this.pendingWelcomes.has(messageId)) {
                    continue;
                }
                if (messageId && (this.processedMessageIds.has(messageId) || this.processingMessageIds.has(messageId))) {
                    continue;
                }
                if (messageId) this.processingMessageIds.add(messageId);

                try {
                    if (msg.message_type === 'welcome') {
                        // msg.data is from Postgres bytea
                        let welcomeBytes;
                        if (msg.data && msg.data.type === 'Buffer') {
                            welcomeBytes = new Uint8Array(msg.data.data);
                        } else if (typeof msg.data === 'string' && msg.data.startsWith('\\x')) {
                            const hex = msg.data.substring(2);
                            welcomeBytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
                        } else {
                            welcomeBytes = new Uint8Array(msg.data);
                        }

                        let groupInfoBytes = null;
                        if (msg.group_info) {
                            if (msg.group_info.type === 'Buffer' && Array.isArray(msg.group_info.data)) {
                                groupInfoBytes = new Uint8Array(msg.group_info.data);
                            } else if (typeof msg.group_info === 'string' && msg.group_info.startsWith('\\x')) {
                                const hex = msg.group_info.substring(2);
                                groupInfoBytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
                            } else if (msg.group_info instanceof Uint8Array) {
                                groupInfoBytes = msg.group_info;
                            } else if (Array.isArray(msg.group_info)) {
                                groupInfoBytes = new Uint8Array(msg.group_info);
                            }
                        }

                        const staged = await this.stageWelcome(welcomeBytes, null);
                        const validation = this.validateStagedWelcomeMembers(staged.stagingId);

                        if (!validation.valid) {
                            console.warn('[MLS] Staged welcome failed validation:', validation.issues);
                            this.rejectStagedWelcome(staged.stagingId);
                            if (messageId) this.processedMessageIds.add(messageId);
                            continue;
                        }

                        let welcomeOutcome = 'accepted';
                        if (this.welcomeRequestHandlers.length > 0 && messageId) {
                            const pendingWelcome = {
                                id: messageId,
                                stagingId: staged.stagingId,
                                groupId: staged.groupId,
                                senderUserId: msg.sender_user_id,
                                senderDeviceId: msg.sender_device_id,
                                welcomeBytes,
                                groupInfoBytes,
                                members: staged.members,
                                sender: staged.sender
                            };
                            this.pendingWelcomes.set(messageId, pendingWelcome);

                            const pendingSummary = {
                                id: messageId,
                                stagingId: staged.stagingId,
                                groupId: staged.groupId,
                                senderUserId: msg.sender_user_id,
                                senderDeviceId: msg.sender_device_id,
                                welcomeHex: this.bytesToHex(welcomeBytes),
                                groupInfoHex: groupInfoBytes ? this.bytesToHex(groupInfoBytes) : null,
                                members: staged.members,
                                sender: staged.sender,
                                validation
                            };

                            let decision;
                            for (const handler of this.welcomeRequestHandlers) {
                                const result = await handler(pendingSummary);
                                if (typeof result === 'boolean') {
                                    decision = result;
                                    break;
                                }
                            }

                            if (decision === true) {
                                welcomeOutcome = 'accepted';
                            } else if (decision === false) {
                                welcomeOutcome = 'rejected';
                            } else {
                                welcomeOutcome = 'pending';
                            }
                        }

                        if (welcomeOutcome === 'accepted') {
                            const groupId = await this.acceptStagedWelcome(staged.stagingId);
                            this.pendingWelcomes.delete(messageId);
                            this.welcomeHandlers.forEach(h => h({ groupId, groupInfoBytes }));
                            if (messageId) this.processedMessageIds.add(messageId);
                        } else if (welcomeOutcome === 'rejected') {
                            this.rejectStagedWelcome(staged.stagingId);
                            this.pendingWelcomes.delete(messageId);
                            if (messageId) this.processedMessageIds.add(messageId);
                        } else {
                            continue;
                        }
                    } else {
                        const result = await this.handleIncomingMessage({
                            id: msg.id,
                            group_id: msg.group_id,
                            data: msg.data,
                            content_type: msg.message_type,
                            sender_id: msg.sender_device_id,
                            sender_user_id: msg.sender_user_id
                            // Actually handleIncomingMessage uses sender_id to check if it's own message.
                            // We might need to pass sender identity or deviceId.
                        });

                        if (!result.skipped) {
                            this.messageHandlers.forEach(h => h(result));
                        }
                    }
                    if (messageId) {
                        processedIds.push(messageId);
                    }
                } catch (e) {
                    console.error('[MLS] Failed to process queued message:', msg.id, e);
                } finally {
                    if (messageId) this.processingMessageIds.delete(messageId);
                }
            }

            if (processedIds.length > 0) {
                await api.mls.ackMessages(processedIds);
                console.log(`[MLS] Acked ${processedIds.length} messages`);
            }

            return processedIds;
        } catch (e) {
            console.error('[MLS] Error during message sync:', e);
            return [];
        }
    }

    /**
     * Handle an incoming encrypted message from the server
     * @param {Object} messageData - Message object from server/socket
     * @returns {Promise<Object>} Processed message with plaintext
     */
    async handleIncomingMessage(messageData) {
        if (!this.client) throw new Error('Client not initialized');

        const { group_id, data, content_type, sender_id, sender_user_id, id } = messageData;
        const senderUserId = sender_user_id || sender_id;

        // Skip already processed messages (deduplication)
        if (id && this.processedMessageIds.has(id)) {
            return { id, groupId: group_id, senderId: sender_id, type: 'duplicate', skipped: true };
        }

        if (content_type === 'application') {
            // Note: sender_id is now senderDeviceId. 
            // To check if it's own message, we compare with our own deviceId.
            const vaultService = (await import('../vaultService.js')).default;
            const myDeviceId = vaultService.getDeviceId();

            // We need to resolve deviceId to identityName if UI expects it, 
            // or just use deviceId for now.

            // For now, let's assume we can't easily check identityName without more info.
            // But we CAN check if it's our own device.
            // (We might need sender identity in the relay queue too if UI needs it).

            // Decrypt normally (WASM will fail if it's our own and not stored in history)
            let plaintext;
            let epoch = null;
            try {
                const decrypted = this.decryptMessage(group_id, data);
                plaintext = decrypted.plaintext;
                epoch = decrypted.epoch;
                const aadCheck = this.validateAad(decrypted.aadBytes, {
                    groupId: group_id,
                    epoch: decrypted.epoch,
                    type: 'application'
                });
                if (!aadCheck.valid) {
                    console.warn('[MLS] Application AAD validation failed:', aadCheck.reason);
                    if (id) this.processedMessageIds.add(id);
                    return { id, groupId: group_id, senderId: senderUserId, senderDeviceId: sender_id, type: 'invalid_aad', skipped: true };
                }
            } catch (e) {
                // If decryption fails, it might be our own message from another device,
                // or a message we already have. 
                // In MLS, you can't decrypt messages you sent.
                plaintext = '[Encrypted Message]';
                if (sender_id && sender_id !== myDeviceId) {
                    this.emitForkDetected({
                        groupId: group_id,
                        epoch: null,
                        reason: 'decrypt_failed',
                        senderDeviceId: sender_id
                    });
                }
            }

            if (id) this.processedMessageIds.add(id);

            if (plaintext && plaintext !== '[Encrypted Message]') {
                let payload = null;
                try {
                    payload = JSON.parse(plaintext);
                } catch (e) {}
                if (payload && payload.__mls_type === 'confirmation_tag') {
                    await this.handleConfirmationTagMessage(group_id, payload, senderUserId);
                    return { id, groupId: group_id, senderId: senderUserId, senderDeviceId: sender_id, type: 'system', skipped: true };
                }
            }
            
            const messageObj = {
                id,
                groupId: group_id,
                senderId: senderUserId,
                senderDeviceId: sender_id,
                plaintext,
                type: 'application',
                timestamp: new Date().toISOString()
            };
            
            // Persist to encrypted local storage
            if (plaintext && plaintext !== '[Encrypted Message]') {
                const vaultService = (await import('../vaultService.js')).default;
                await vaultService.persistMessage(messageObj);
            }
            
            return messageObj;
        } else if (content_type === 'proposal') {
            const proposalResult = await this.processProposal(group_id, data);
            if (id) this.processedMessageIds.add(id);
            return {
                id,
                groupId: group_id,
                senderId: senderUserId,
                senderDeviceId: sender_id,
                type: 'proposal',
                accepted: proposalResult.accepted,
                summary: proposalResult.summary || null
            };
        } else if (content_type === 'commit') {
            await this.processCommit(group_id, data);
            if (id) this.processedMessageIds.add(id);
            return { id, groupId: group_id, senderId: senderUserId, senderDeviceId: sender_id, type: 'commit' };
        } else {
            if (id) this.processedMessageIds.add(id);
            return { id, groupId: group_id, senderId: senderUserId, senderDeviceId: sender_id, type: 'unknown' };
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

        const groupIdBytes = this.groupIdToBytes(groupId);

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

        const summary = this.client.process_commit(groupIdBytes, commitBytes);
        const commitEpoch = typeof summary?.epoch === 'bigint' ? Number(summary.epoch) : summary?.epoch;
        const aadBytes = summary?.aad_hex ? this.hexToBytes(summary.aad_hex) : new Uint8Array();
        const aadCheck = this.validateAad(aadBytes, {
            groupId,
            epoch: commitEpoch,
            type: 'commit'
        });
        if (!aadCheck.valid) {
            try {
                this.client.discard_staged_commit(groupIdBytes);
            } catch (discardErr) {
                console.warn('[MLS] Failed to discard staged commit:', discardErr);
            }
            console.warn('[MLS] Commit rejected due to AAD mismatch:', aadCheck.reason);
            this.emitCommitRejected({ groupId, reason: aadCheck.reason, type: 'commit', epoch: commitEpoch });
            return { accepted: false };
        }
        const policyAccepted = await this.validateStagedCommit(groupId, summary);
        if (!policyAccepted) {
            try {
                this.client.discard_staged_commit(groupIdBytes);
            } catch (discardErr) {
                console.warn('[MLS] Failed to discard staged commit:', discardErr);
            }
            console.warn('[MLS] Commit rejected by app policy for group:', groupId);
            this.emitCommitRejected({ groupId, reason: 'policy_violation', type: 'commit', epoch: commitEpoch });
            return { accepted: false };
        }

        try {
            this.client.merge_staged_commit(groupIdBytes);
        } catch (mergeErr) {
            console.warn('[MLS] Failed to merge staged commit:', mergeErr);
            throw mergeErr;
        }

        console.log('[MLS] Processed commit for group:', groupId);

        // Save state after processing commit (epoch advanced, keys rotated)
        await this.saveState();

        try {
            const currentEpoch = this.getGroupEpoch(groupId);
            await this.broadcastConfirmationTag(groupId, currentEpoch);
        } catch (tagErr) {
            console.warn('[MLS] Failed to broadcast confirmation tag:', tagErr);
        }

        // Persist to vault if unlocked
        try {
            const vaultService = (await import('../vaultService.js')).default;
            await vaultService.saveCurrentState();
            console.log('[MLS] Commit state saved to vault');
        } catch (vaultErr) {
            console.warn('[MLS] Could not save commit state to vault:', vaultErr.message);
        }

        try {
            await this.syncGroupMembers(groupId);
        } catch (syncErr) {
            console.warn('[MLS] Failed to sync group members:', syncErr);
        }

        return { accepted: true };
    }

    async processProposal(groupId, proposalData) {
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        let proposalBytes;
        if (typeof proposalData === 'string') {
            let hex = proposalData;
            if (hex.startsWith('\\x')) hex = hex.substring(2);
            proposalBytes = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        } else if (proposalData?.type === 'Buffer' && Array.isArray(proposalData.data)) {
            proposalBytes = new Uint8Array(proposalData.data);
        } else {
            proposalBytes = proposalData;
        }

        const summary = this.client.process_proposal(groupIdBytes, proposalBytes);
        const proposalEpoch = typeof summary?.epoch === 'bigint' ? Number(summary.epoch) : summary?.epoch;
        const aadBytes = summary?.aad_hex ? this.hexToBytes(summary.aad_hex) : new Uint8Array();
        const aadCheck = this.validateAad(aadBytes, {
            groupId,
            epoch: proposalEpoch,
            type: 'proposal'
        });
        if (!aadCheck.valid) {
            try {
                this.client.clear_pending_proposals(groupIdBytes);
            } catch (clearErr) {
                console.warn('[MLS] Failed to clear pending proposals:', clearErr);
            }
            console.warn('[MLS] Proposal rejected due to AAD mismatch:', aadCheck.reason);
            this.emitCommitRejected({ groupId, reason: aadCheck.reason, type: 'proposal', epoch: proposalEpoch });
            return { accepted: false };
        }

        const policyAccepted = await this.validateStagedCommit(groupId, summary);
        if (!policyAccepted) {
            try {
                this.client.clear_pending_proposals(groupIdBytes);
            } catch (clearErr) {
                console.warn('[MLS] Failed to clear pending proposals:', clearErr);
            }
            console.warn('[MLS] Proposal rejected by app policy for group:', groupId);
            this.emitCommitRejected({ groupId, reason: 'policy_violation', type: 'proposal', epoch: proposalEpoch });
            return { accepted: false };
        }

        await this.saveState();
        return { accepted: true, summary };
    }

    clearPendingProposals(groupId) {
        if (!this.client) throw new Error('Client not initialized');
        const groupIdBytes = this.groupIdToBytes(groupId);
        this.client.clear_pending_proposals(groupIdBytes);
    }

    async commitPendingProposals(groupId, { welcomeRecipients = [] } = {}) {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        if (!this.client) throw new Error('Client not initialized');

        const groupIdBytes = this.groupIdToBytes(groupId);
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        const { default: vaultService } = await import('../vaultService.js');
        const deviceId = vaultService.getDeviceId();
        if (!deviceId) {
            throw new Error('Device ID not available. Unlock or set up your keystore first.');
        }

        // Capture rollback state before committing
        const rollbackState = await this.exportStateForVault();

        this.setGroupAad(groupId, 'commit');
        const result = this.client.commit_pending_proposals(groupIdBytes);
        const commitBytes = new Uint8Array(result[0] || []);
        const welcomeBytes = result[1] ? new Uint8Array(result[1]) : null;
        const groupInfoBytes = result[2] ? new Uint8Array(result[2]) : null;
        const epoch = this.getGroupEpoch(groupId);

        const commitResponse = await fetch('/api/mls/messages/group', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id': deviceId
            },
            body: JSON.stringify({
                groupId,
                epoch,
                messageType: 'commit',
                data: '\\x' + this.bytesToHex(commitBytes)
            })
        });

        if (!commitResponse.ok) {
            const error = await commitResponse.json().catch(() => ({}));
            try {
                this.client.clear_pending_commit(groupIdBytes);
            } catch (clearErr) {
                console.warn('[MLS] Failed to clear pending commit:', clearErr);
            }
            // Restore state on failure
            if (rollbackState) {
                await this.restoreStateFromVault(rollbackState);
            }
            throw new Error(error.error || 'Failed to send commit for pending proposals');
        }

        try {
            this.client.merge_pending_commit(groupIdBytes);
        } catch (mergeErr) {
            console.warn('[MLS] Failed to merge pending commit:', mergeErr);
            throw mergeErr;
        }

        // Broadcast confirmation tag for fork detection
        try {
            const currentEpoch = this.getGroupEpoch(groupId);
            await this.broadcastConfirmationTag(groupId, currentEpoch);
        } catch (tagErr) {
            console.warn('[MLS] Failed to broadcast confirmation tag:', tagErr);
        }

        // Send welcomes with error tracking
        const failedRecipients = [];
        if (welcomeBytes && welcomeRecipients.length > 0) {
            for (const receiverId of welcomeRecipients) {
                try {
                    const welcomeResponse = await fetch('/api/mls/messages/welcome', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                            'x-device-id': deviceId
                        },
                        body: JSON.stringify({
                            groupId,
                            receiverId,
                            data: '\\x' + this.bytesToHex(welcomeBytes),
                            groupInfo: groupInfoBytes ? ('\\x' + this.bytesToHex(groupInfoBytes)) : null
                        })
                    });
                    if (!welcomeResponse.ok) {
                        console.warn(`[MLS] Failed to send welcome to ${receiverId}`);
                        failedRecipients.push(receiverId);
                    }
                } catch (welcomeErr) {
                    console.warn(`[MLS] Error sending welcome to ${receiverId}:`, welcomeErr);
                    failedRecipients.push(receiverId);
                }
            }
        }

        await this.saveState();

        try {
            await vaultService.saveCurrentState();
        } catch (vaultErr) {
            console.warn('[MLS] Could not save commit state to vault:', vaultErr.message);
        }

        return { commitBytes, welcomeBytes, groupInfoBytes, failedRecipients };
    }

    async validateStagedCommit(groupId, summary) {
        if (!summary) return true;

        const adds = Array.isArray(summary.adds) ? summary.adds : [];
        const updates = Array.isArray(summary.updates) ? summary.updates : [];
        const removes = Array.isArray(summary.removes) ? summary.removes : [];

        const lifetimeViolations = [...adds, ...updates].some(entry => {
            if (!entry || !entry.lifetime) return false;
            return !this.keyPackageLifetimeAcceptable(entry.lifetime);
        });
        if (lifetimeViolations) {
            console.warn('[MLS] Commit contains leaf nodes with unacceptable lifetime range; rejecting.');
            return false;
        }

        const missingAddLifetime = adds.some(entry => entry && !entry.lifetime);
        if (missingAddLifetime) {
            console.warn('[MLS] Commit add proposal missing lifetime; rejecting.');
            return false;
        }

        const invalidCredential = [...adds, ...updates]
            .some(entry => entry && entry.is_basic === false);

        if (invalidCredential) {
            console.warn('[MLS] Commit contains non-basic credentials; rejecting.');
            return false;
        }

        const currentIdentities = new Set(this.getGroupMemberIdentities(groupId));
        const addIdentities = adds.map(entry => entry?.identity).filter(Boolean);
        const updateIdentities = updates.map(entry => entry?.identity).filter(Boolean);
        const removeIdentities = removes.map(entry => entry?.identity?.identity).filter(Boolean);
        const missingRemoveIdentity = removes.some(entry => entry && entry.identity == null);

        if (missingRemoveIdentity) {
            console.warn('[MLS] Commit remove proposal missing identity; rejecting.');
            return false;
        }

        const allIdentities = [...addIdentities, ...updateIdentities, ...removeIdentities];

        if (this.isDirectMessage(groupId)) {
            const allowed = new Set(this.getDmParticipantIds(groupId));
            if (allowed.size === 0) return false;
            if (adds.length > 1) return false;

            // Convert identities to strings for comparison (getDmParticipantIds returns strings)
            if (allIdentities.some(identity => !allowed.has(String(identity)))) {
                console.warn('[MLS] DM commit contains unexpected identity; rejecting.');
                return false;
            }

            if (addIdentities.some(identity => currentIdentities.has(identity))) {
                console.warn('[MLS] DM commit re-adds existing member; rejecting.');
                return false;
            }

            if (updateIdentities.some(identity => !currentIdentities.has(identity))) {
                console.warn('[MLS] DM commit updates unknown member; rejecting.');
                return false;
            }

            if (removeIdentities.some(identity => !currentIdentities.has(identity))) {
                console.warn('[MLS] DM commit removes unknown member; rejecting.');
                return false;
            }
        } else {
            if (allIdentities.some(identity => !this.isNumericIdentity(identity))) {
                console.warn('[MLS] Commit add identity not numeric; rejecting.');
                return false;
            }

            if (addIdentities.some(identity => currentIdentities.has(identity))) {
                console.warn('[MLS] Commit adds existing member; rejecting.');
                return false;
            }

            if (updateIdentities.some(identity => !currentIdentities.has(identity))) {
                console.warn('[MLS] Commit updates unknown member; rejecting.');
                return false;
            }

            if (removeIdentities.some(identity => !currentIdentities.has(identity))) {
                console.warn('[MLS] Commit removes unknown member; rejecting.');
                return false;
            }
        }

        return true;
    }

    /**
     * Set up socket event listeners for real-time MLS events
     */
    setupSocketListeners() {
        if (this._socketCleanup) return; // Already set up

        const cleanupWelcome = registerSocketEventHandler('mls-welcome', () => this.syncMessages());
        const cleanupMessage = registerSocketEventHandler('mls-message', () => this.syncMessages());

        this._socketCleanup = () => {
            cleanupWelcome();
            cleanupMessage();
        };

        // Initial sync
        this.syncMessages();
        console.log('[MLS] Socket listeners and initial sync set up');
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
            const processedIds = await this.syncMessages();
            if (processedIds.length > 0) {
                console.log('[MLS] Processed pending invites after vault restore:', processedIds.length);
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
            const processedIds = await this.syncMessages();
            if (processedIds.length > 0) {
                console.log('[MLS] Processed pending invites, processed IDs:', processedIds.length);
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
                const groupIdBytes = this.groupIdToBytes(groupIdHex);

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
        this.confirmationTags.clear();
        this.remoteConfirmationTags.clear();
        this.sentConfirmationTags.clear();
        console.log('[MLS] Memory wiped');
    }

    /**
     * Clear all stored state (for switching users)
     * @returns {Promise<void>}
     */
    async clearState() {
        this.wipeMemory();

        // Clean up legacy openmls_storage DB if it exists (one-time migration)
        try {
            indexedDB.deleteDatabase('openmls_storage');
        } catch (e) {
            // Ignore errors - DB may not exist
        }
    }

    /**
     * Register a callback for incoming MLS messages
     * @param {Function} callback - Function to call with decrypted message
     * @returns {Function} Unsubscribe function
     */
    onMessage(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onMessage requires a function callback');
        }
        this.messageHandlers.push(callback);
        // Return unsubscribe function
        return () => {
            const index = this.messageHandlers.indexOf(callback);
            if (index > -1) {
                this.messageHandlers.splice(index, 1);
            }
        };
    }

    /**
     * Register a callback for incoming welcome messages (group invites)
     * @param {Function} callback - Function to call when invited to a group
     * @returns {Function} Unsubscribe function
     */
    onWelcome(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onWelcome requires a function callback');
        }
        this.welcomeHandlers.push(callback);
        return () => {
            const index = this.welcomeHandlers.indexOf(callback);
            if (index > -1) {
                this.welcomeHandlers.splice(index, 1);
            }
        };
    }

    /**
     * Register a callback for pending welcome requests (approval/inspection)
     * @param {Function} callback - Function invoked with pending welcome summary
     * @returns {Function} Unsubscribe function
     */
    onWelcomeRequest(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onWelcomeRequest requires a function callback');
        }
        this.welcomeRequestHandlers.push(callback);
        return () => {
            const index = this.welcomeRequestHandlers.indexOf(callback);
            if (index > -1) {
                this.welcomeRequestHandlers.splice(index, 1);
            }
        };
    }

    onForkDetected(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onForkDetected requires a function callback');
        }
        this.forkHandlers.push(callback);
        return () => {
            const index = this.forkHandlers.indexOf(callback);
            if (index > -1) {
                this.forkHandlers.splice(index, 1);
            }
        };
    }

    emitForkDetected(details) {
        if (!details) return;
        this.forkHandlers.forEach(handler => {
            try {
                handler(details);
            } catch (e) {
                console.warn('[MLS] Fork handler error:', e);
            }
        });
    }

    /**
     * Register a callback for commit/proposal rejection events
     * @param {Function} callback - Function to call when a commit/proposal is rejected
     * @returns {Function} Unsubscribe function
     */
    onCommitRejected(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onCommitRejected requires a function callback');
        }
        this.commitRejectionHandlers.push(callback);
        return () => {
            const index = this.commitRejectionHandlers.indexOf(callback);
            if (index > -1) {
                this.commitRejectionHandlers.splice(index, 1);
            }
        };
    }

    /**
     * Emit a commit/proposal rejection event
     * @param {Object} details - { groupId, reason, type: 'commit'|'proposal', epoch? }
     */
    emitCommitRejected(details) {
        if (!details) return;
        this.commitRejectionHandlers.forEach(handler => {
            try {
                handler(details);
            } catch (e) {
                console.warn('[MLS] Commit rejection handler error:', e);
            }
        });
    }

    async acceptWelcome(pending) {
        if (!pending) throw new Error('Pending welcome required');
        const pendingId = typeof pending === 'object' ? pending.id : pending;
        if (!pendingId) throw new Error('Pending welcome id missing');

        let record = this.pendingWelcomes.get(pendingId);
        if (!record && typeof pending === 'object' && pending.welcomeHex) {
            record = {
                id: pendingId,
                groupId: pending.groupId,
                senderUserId: pending.senderUserId,
                senderDeviceId: pending.senderDeviceId,
                welcomeBytes: this.hexToBytes(pending.welcomeHex),
                groupInfoBytes: pending.groupInfoHex ? this.hexToBytes(pending.groupInfoHex) : null,
                stagingId: pending.stagingId,
                members: pending.members,
                sender: pending.sender
            };
        }

        if (!record || !record.welcomeBytes) {
            throw new Error('Pending welcome not found');
        }

        let stagingId = record.stagingId;
        if (!stagingId) {
            const staged = await this.stageWelcome(record.welcomeBytes, null);
            stagingId = staged.stagingId;
        }

        const validation = this.validateStagedWelcomeMembers(stagingId);
        if (!validation.valid) {
            this.rejectStagedWelcome(stagingId);
            throw new Error(`Welcome validation failed: ${validation.issues.join(', ')}`);
        }

        const groupId = await this.acceptStagedWelcome(stagingId);
        this.pendingWelcomes.delete(pendingId);
        await api.mls.ackMessages([pendingId]);
        this.processedMessageIds.add(pendingId);
        this.welcomeHandlers.forEach(h => h({ groupId, groupInfoBytes: record.groupInfoBytes }));
        return groupId;
    }

    async rejectWelcome(pending) {
        if (!pending) throw new Error('Pending welcome required');
        const pendingId = typeof pending === 'object' ? pending.id : pending;
        if (!pendingId) throw new Error('Pending welcome id missing');
        const record = this.pendingWelcomes.get(pendingId) || pending;
        if (record?.stagingId) {
            this.rejectStagedWelcome(record.stagingId);
        }
        this.pendingWelcomes.delete(pendingId);
        await api.mls.ackMessages([pendingId]);
        this.processedMessageIds.add(pendingId);
    }

    /**
     * Fetch and decrypt messages for a specific group
     * @param {string} groupId - The MLS group ID
     * @returns {Promise<Array>} Array of decrypted messages
     */
    async fetchAndDecryptMessages(groupId) {
        if (!this.initialized) await this.initialize();
        if (!this.client) return [];

        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');

        try {
            const response = await fetch(`/api/mls/messages/group/${encodeURIComponent(groupId)}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch messages: ${response.status}`);
            }

            const messages = await response.json();
            const decrypted = [];

            for (const msg of messages) {
                try {
                    const result = await this.handleIncomingMessage({
                        id: msg.id,
                        group_id: groupId,
                        data: msg.data,
                        content_type: msg.message_type,
                        sender_id: msg.sender_user_id
                    });
                    if (result && !result.skipped) {
                        decrypted.push(result);
                    }
                } catch (e) {
                    console.warn('[MLS] Failed to decrypt message:', msg.id, e);
                }
            }

            return decrypted;
        } catch (err) {
            console.error('[MLS] Error fetching messages:', err);
            return [];
        }
    }
}

export default new CoreCryptoClient();
