import init, { MlsClient, init_logging } from 'openmls-wasm';
import { registerSocketEventHandler } from '../socket.js';
import { api } from '../api.js';

const KEY_PACKAGE_RENEWAL_WINDOW_SECONDS = 60 * 60 * 24 * 7;
const MAX_LEAF_NODE_LIFETIME_RANGE_SECONDS = (60 * 60 * 24 * 28 * 3) + (60 * 60);
const KEY_PACKAGE_POOL_TARGET = 10;
const KEY_PACKAGE_POOL_MIN = 3;

class CoreCryptoClient {
    constructor() {
        this.client = null;
        this.initialized = false;
        this.identityName = null;
        this.messageHandlers = [];
        this.welcomeHandlers = [];
        this.welcomeRequestHandlers = [];
        this.pendingWelcomes = new Map();
        this.confirmationTags = new Map();
        this.remoteConfirmationTags = new Map();
        this.sentConfirmationTags = new Map();
        this.forkHandlers = [];
        this.commitRejectionHandlers = [];
        this._socketCleanup = null;
        this.processedMessageIds = new Set();
        this.processingMessageIds = new Set();
        this.syncPromise = null;
        this.bootstrapPromise = null;
        this.bootstrapUser = null;
        this._vaultService = null;
    }

    // ===== CORE HELPERS (DRY) =====

    async getVaultService() {
        if (!this._vaultService) {
            this._vaultService = (await import('../vaultService.js')).default;
        }
        return this._vaultService;
    }

    requireClient() {
        if (!this.client) throw new Error('Client not initialized');
        return this.client;
    }

    async requireDeviceId(message = 'Device ID not available') {
        const { deviceId } = await this.getAuthContext();
        if (!deviceId) throw new Error(message);
        return deviceId;
    }

    async ensureReady() {
        if (!this.initialized) await this.initialize();
        if (!this.client && this.identityName) await this.loadState(this.identityName);
        this.requireClient();
    }

    async getAuthContext() {
        const token = localStorage.getItem('token');
        if (!token) throw new Error('Not authenticated');
        const vault = await this.getVaultService();
        const deviceId = vault.getDeviceId();
        return { token, deviceId };
    }

    toPostgresHex(bytes) {
        return '\\x' + this.bytesToHex(bytes);
    }

    normalizeGroupId(input) {
        const bytes = this.groupIdToBytes(input);
        const str = typeof input === 'string' ? input : this.groupIdFromBytes(bytes);
        return { bytes, str };
    }

    async mlsFetch(endpoint, body, { method = 'POST', skipDeviceId = false, errorMessage = null, authContext = null } = {}) {
        const { token, deviceId } = authContext || await this.getAuthContext();
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        };
        if (!skipDeviceId && deviceId) headers['x-device-id'] = deviceId;

        const response = await fetch(`/api/mls${endpoint}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || errorMessage || `MLS API error: ${endpoint}`);
        }
        return response.json();
    }

    // Handler factory - creates on/emit pairs for event handlers
    _createHandler(handlers) {
        return (callback) => {
            if (typeof callback !== 'function') throw new Error('Callback must be a function');
            handlers.push(callback);
            return () => { const i = handlers.indexOf(callback); if (i > -1) handlers.splice(i, 1); };
        };
    }

    _emit(handlers, data) {
        if (!data) return;
        handlers.forEach(h => { try { h(data); } catch (e) { console.warn('[MLS] Handler error:', e); } });
    }

    markProcessed(id) {
        if (!id) return;
        this.processedMessageIds.add(id);
        this.processingMessageIds.delete(id);

        this.getVaultService().then(vault => {
            vault.markMessageProcessed(id).catch(e => console.warn('[MLS] Failed to save processed ID:', e));
        });

        if (this.processedMessageIds.size > 2000) {
            const arr = Array.from(this.processedMessageIds);
            this.processedMessageIds = new Set(arr.slice(arr.length - 1000));
        }
    }

    async loadProcessedIDs() {
        try {
            const vault = await this.getVaultService();
            const recentIds = await vault.getRecentProcessedMessages(2000);
            for (const id of recentIds) {
                this.processedMessageIds.add(id);
            }
        } catch (e) {
            console.warn('[MLS] Failed to load processed IDs', e);
        }
    }

    // Unified byte parser for all formats (postgres bytea, Buffer, hex, Uint8Array)
    _toBytes(data) {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data?.type === 'Buffer' && Array.isArray(data.data)) return new Uint8Array(data.data);
        if (typeof data === 'string') {
            let hex = data.startsWith('\\x') ? data.slice(2) : data;
            if (/^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0) {
                return hex.length ? new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16))) : new Uint8Array();
            }
        }
        return null;
    }

    // ===== END CORE HELPERS =====

    async initialize() {
        if (this.initialized) return;

        try {
            await init();
            init_logging();
            this.initialized = true;
        } catch (error) {
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
        } catch (e) { }
        return this.bytesToHex(groupIdBytes);
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
        this.requireClient();
        const groupIdValue = typeof groupId === 'string' ? groupId : this.groupIdFromBytes(groupId);
        const epoch = typeof epochOverride === 'number' ? epochOverride : this.getGroupEpoch(groupIdValue);
        const payload = this.buildAadPayload(groupIdValue, epoch, type);
        const aadBytes = this.encodeAad(payload);
        const groupIdBytes = this.groupIdToBytes(groupIdValue);
        this.client.set_group_aad(groupIdBytes, aadBytes);
        return payload;
    }

    // Save client state (drains granular events, persists encrypted)
    async saveState() {
        if (!this.client) return;
        try {
            const vault = await this.getVaultService();
            if (!vault.isUnlocked()) return;
            const events = this.client.drain_storage_events();
            if (events?.length > 0) await vault.persistGranularEvents(events);
        } catch (e) {
            console.warn('[MLS] Failed to persist granular events:', e);
        }
    }

    // Load state - returns false (actual restore is via restoreStateFromVault)
    async loadState(username) { return false; }

    // Ensure client is bootstrapped (with lock to prevent concurrent calls)
    async ensureMlsBootstrap(username) {
        if (this.bootstrapPromise && this.bootstrapUser === username) return this.bootstrapPromise;

        // Start bootstrap and store promise
        this.bootstrapUser = username;
        this.bootstrapPromise = this._doMlsBootstrap(username);

        try {
            await this.bootstrapPromise;
        } finally {
            // Clear the lock when done (success or failure)
            this.bootstrapPromise = null;
            this.bootstrapUser = null;
        }
    }

    async _doMlsBootstrap(username) {
        if (!this.initialized) await this.initialize();

        if (this.client && this.identityName === username) {
            this.setupSocketListeners();
            return;
        }

        if (this.client && this.identityName !== username) {
            this.cleanupSocketListeners();
            try { this.client.free(); } catch (e) { }
            this.client = null;
            this.identityName = null;
        }

        if (await this.loadState(username)) {
            this.setupSocketListeners();
            return;
        }

        try {
            this.client = new MlsClient();
            this.identityName = username;
            this.client.create_identity(username);
            this.client.regenerate_key_package();
            await this.saveState();
            // Note: saveCurrentState() is NOT called here during initial bootstrap
            // because the IndexedDB record doesn't exist yet. The caller
            // (setupKeystoreWithPassword) saves state after creating the record.
            this.setupSocketListeners();
        } catch (error) {
            console.error('Error bootstrapping MLS client:', error);
            throw error;
        }
    }

    getKeyPackageBytes() {
        this.requireClient();
        return this.client.get_key_package_bytes();
    }

    getKeyPackageHex() {
        return this.bytesToHex(this.getKeyPackageBytes());
    }

    getKeyPackageLifetimeInfo() {
        this.requireClient();
        return this.client.get_key_package_lifetime();
    }

    getKeyPackageLifetimeInfoFromBytes(keyPackageBytes) {
        this.requireClient();
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

    async computeHash(data) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return this.bytesToHex(new Uint8Array(hashBuffer));
    }

    async uploadKeyPackage(options = {}) {
        this.requireClient();
        const authContext = await this.getAuthContext();
        const { deviceId } = authContext;
        if (!deviceId) {
            console.warn('[MLS] Skipping key package upload (device ID not set)');
            return null;
        }

        const { keyPackageBytes: providedBytes = null, isLastResort = false, precomputedLifetime = null, precomputedHash = null } = options;
        const keyPackageBytes = providedBytes || this.getKeyPackageBytes();
        const hash = precomputedHash || await this.computeHash(keyPackageBytes);
        let lifetimeInfo = precomputedLifetime;
        if (!lifetimeInfo) {
            try {
                lifetimeInfo = providedBytes ? this.getKeyPackageLifetimeInfoFromBytes(keyPackageBytes) : this.getKeyPackageLifetimeInfo();
            } catch (e) {
                console.warn('[MLS] Could not extract lifetime from key package:', e.message || e);
            }
        }

        return this.mlsFetch('/key-package', {
            deviceId,
            packageData: this.toPostgresHex(keyPackageBytes),
            hash,
            notBefore: lifetimeInfo?.not_before ?? null,
            notAfter: lifetimeInfo?.not_after ?? null,
            isLastResort
        }, { skipDeviceId: true, errorMessage: 'Failed to upload key package', authContext });
    }

    // Ensure key packages are fresh (consolidated: generates all, uploads bulk, saves once)
    async ensureKeyPackagesFresh() {
        this.requireClient();

        const { deviceId } = await this.getAuthContext();
        if (!deviceId) {
            console.warn('[MLS] Skipping key package refresh (device ID not set)');
            return;
        }

        try {
            const counts = await this.getKeyPackageCount();

            const allPackages = [];

            // Generate regular key packages to fill pool
            const regularNeeded = Math.max(0, KEY_PACKAGE_POOL_TARGET - counts.regular);
            if (regularNeeded > 0) {
                const result = this.client.generate_key_packages(regularNeeded);
                for (const kp of result.key_packages) {
                    allPackages.push({
                        packageData: this.toPostgresHex(new Uint8Array(kp.key_package_bytes)),
                        hash: kp.hash,
                        notBefore: kp.lifetime?.not_before ?? null,
                        notAfter: kp.lifetime?.not_after ?? null,
                        isLastResort: false
                    });
                }
            }

            // Generate last-resort key package if missing
            if (counts.lastResort === 0) {
                const lrResult = this.client.generate_last_resort_key_package();
                allPackages.push({
                    packageData: this.toPostgresHex(new Uint8Array(lrResult.key_package_bytes)),
                    hash: lrResult.hash,
                    notBefore: lrResult.lifetime?.not_before ?? null,
                    notAfter: lrResult.lifetime?.not_after ?? null,
                    isLastResort: true
                });
            }

            if (allPackages.length === 0) return;

            await this.saveState();
            await this.uploadKeyPackagesBulk(allPackages);
        } catch (e) {
            console.warn('[MLS] Failed to ensure key packages:', e.message || e);
        }
    }

    async uploadKeyPackagesBulk(keyPackages) {
        if (!keyPackages?.length) return { inserted: 0 };

        const authContext = await this.getAuthContext();
        const { deviceId } = authContext;
        if (!deviceId) return null;

        return this.mlsFetch('/key-packages', { deviceId, keyPackages }, {
            skipDeviceId: true,
            errorMessage: 'Failed to upload key packages',
            authContext
        });
    }

    async getKeyPackageCount() {
        const authContext = await this.getAuthContext();
        const { deviceId } = authContext;
        const endpoint = deviceId
            ? `/key-packages/count?deviceId=${encodeURIComponent(deviceId)}`
            : '/key-packages/count';
        return this.mlsFetch(endpoint, null, {
            method: 'GET',
            skipDeviceId: true,
            errorMessage: 'Failed to get key package count',
            authContext
        });
    }

    async fetchKeyPackages(userId, fetchAll = false, deviceId = null) {
        await this.ensureReady();

        let endpoint = `/key-package/${userId}`;
        const params = new URLSearchParams();
        if (deviceId) params.set('deviceId', deviceId);
        else if (fetchAll) params.set('all', 'true');
        if (params.size > 0) endpoint += `?${params.toString()}`;

        const data = await this.mlsFetch(endpoint, null, {
            method: 'GET',
            skipDeviceId: true,
            errorMessage: 'Failed to fetch key packages'
        });
        const packages = Array.isArray(data) ? data : [data];
        const keyPackageBytes = packages.map(pkg => this._toBytes(pkg?.package_data)).filter(Boolean);

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

    async createGroup(name, options = {}) {
        await this.ensureReady();

        // Generate a random group ID (16 bytes as hex string)
        const groupIdBytes = new Uint8Array(16);
        crypto.getRandomValues(groupIdBytes);
        const groupId = this.bytesToHex(groupIdBytes);

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

            // Persist group metadata in backend
            const groupData = await this.mlsFetch('/groups', { groupId, name }, { skipDeviceId: true });

            // Persist state (granular events)
            await this.saveState();

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
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        const infoBytes = this.client.export_group_info(groupIdBytes, includeRatchetTree);
        return infoBytes instanceof Uint8Array ? infoBytes : new Uint8Array(infoBytes);
    }

    inspectGroupInfo(groupInfoBytes) {
        this.requireClient();
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
        await this.ensureReady();

        const groupInfoBytes = this.exportGroupInfo(groupId, { includeRatchetTree });
        const infoMeta = this.inspectGroupInfo(groupInfoBytes);
        return this.mlsFetch(`/groups/${encodeURIComponent(groupId)}/group-info`, {
            groupInfo: this.toPostgresHex(groupInfoBytes),
            epoch: infoMeta.epoch,
            isPublic: !!isPublic
        }, { skipDeviceId: true });
    }

    async fetchGroupInfo(groupId) {
        const payload = await this.mlsFetch(`/groups/${encodeURIComponent(groupId)}/group-info`, null, {
            method: 'GET',
            skipDeviceId: true,
            errorMessage: 'Failed to fetch group info'
        });
        if (!payload?.groupInfo) throw new Error('Group info not available');

        const groupInfoBytes = this._toBytes(payload.groupInfo);
        if (!groupInfoBytes) throw new Error('Unsupported group info format');
        return { groupInfoBytes, epoch: payload.epoch };
    }

    async joinGroupByExternalCommit({ groupInfoBytes, ratchetTreeBytes = null, pskIds = [] }) {
        await this.ensureReady();

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

        await this._sendGroupCommit({
            groupId: finalGroupId,
            commitBytes,
            epoch: commitEpoch ?? infoMeta.epoch,
            mergePendingCommit: false,
            onCommitFailure: async () => {
                try { this.removeGroup(finalGroupId); } catch (e) { /* ignore */ }
            },
            context: 'external commit join'
        });

        await this.saveState();

        try {
            await this.syncGroupMembers(finalGroupId);
        } catch (syncErr) {
            console.warn('[MLS] Failed to sync group members after external commit:', syncErr);
        }

        await this._broadcastGroupConfirmationTag(finalGroupId, 'after external commit join');

        return {
            groupId: finalGroupId,
            commitEpoch: commitEpoch ?? infoMeta.epoch
        };
    }

    createExternalPsk(pskIdHex = '') {
        this.requireClient();
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
        this.requireClient();
        const pskIdBytes = pskIdSerialized instanceof Uint8Array
            ? pskIdSerialized
            : this.hexToBytes(pskIdSerialized);
        const secret = secretBytes instanceof Uint8Array
            ? secretBytes
            : this.hexToBytes(secretBytes);
        this.client.store_external_psk(pskIdBytes, secret);
    }

    async proposeExternalPsk(groupId, pskIdSerialized) {
        await this.ensureReady();

        const groupIdBytes = this.groupIdToBytes(groupId);
        const pskIdBytes = pskIdSerialized instanceof Uint8Array
            ? pskIdSerialized
            : this.hexToBytes(pskIdSerialized);

        this.setGroupAad(groupId, 'proposal');
        const proposalBytes = this.client.propose_external_psk(groupIdBytes, pskIdBytes);

        const result = await this.mlsFetch('/messages/group', {
            groupId,
            messageType: 'proposal',
            data: this.toPostgresHex(proposalBytes)
        });

        await this.saveState();
        return result;
    }

    async startDirectMessage(targetUserId) {
        await this.ensureReady();

        try {
            // Get or create DM group on backend
            const result = await api.mls.createDirectMessage(targetUserId);
            const { groupId, isNew } = result;

            if (isNew) {
                const groupIdBytes = this.groupIdToBytes(groupId);
                this.client.create_group(groupIdBytes);
                await this.saveState();
                await this.inviteToGroup(groupId, targetUserId);
            } else if (!this.hasGroup(groupId)) {
                // If this device doesn't have the group state yet, try pulling pending Welcomes.
                // If it still isn't available, guide the user instead of failing later with "Group not found".
                try { await this.syncMessages(); } catch { }
                if (!this.hasGroup(groupId)) {
                    throw new Error('Conversation exists but is not available on this device yet. If you have a pending invite, accept it. Otherwise link this device from Settings > Linked Devices, or ask the other user to start a new DM.');
                }
            }

            return { groupId, isNew };
        } catch (e) {
            console.error('[MLS] Error starting direct message:', e);
            throw e;
        }
    }

    isDirectMessage(groupId) {
        return groupId && groupId.startsWith('dm_');
    }

    getGroupEpoch(groupId) {
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        const epoch = this.client.get_group_epoch(groupIdBytes);
        if (typeof epoch === 'bigint') {
            return Number(epoch);
        }
        return epoch;
    }

    hasGroup(groupId) {
        this.requireClient();
        try {
            this.getGroupEpoch(groupId);
            return true;
        } catch {
            return false;
        }
    }

    getGroupMemberIdentities(groupId) {
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        const identities = this.client.get_group_member_identities(groupIdBytes);
        return Array.from(identities || []).filter(Boolean);
    }

    getGroupMembers(groupId) {
        this.requireClient();
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

    async inviteToGroup(groupId, userId, targetDeviceId = null) {
        await this.ensureReady();

        try {
            const keyPackages = await this.fetchKeyPackages(userId, true, targetDeviceId);

            if (keyPackages.length === 0) {
                throw new Error('No key packages found for user');
            }

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
                    await this._sendGroupCommit({
                        groupId,
                        commitBytes,
                        epoch,
                        rollbackState,
                        excludeUserIds: [userId],
                        context: 'invite'
                    });

                    await this._broadcastGroupConfirmationTag(groupId, 'after invite commit');

                    // 5. Upload Welcome Message (new members only, after commit accepted)
                    await this.mlsFetch('/messages/welcome', {
                        groupId, receiverId: userId,
                        data: this.toPostgresHex(welcomeBytes),
                        groupInfo: groupInfoBytes ? this.toPostgresHex(groupInfoBytes) : null
                    });

                    addedCount++;

                    // Save state after EACH member add to persist the new epoch
                    await this.saveState();
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
        await this.ensureReady();

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
        await this.ensureReady();

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
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        this.client.remove_group(groupIdBytes);
    }

    async joinGroup(welcomeBytes, ratchetTreeBytes = null) {
        await this.ensureReady();

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

    // ===== TWO-PHASE JOIN =====
    async stageWelcome(welcomeBytes, ratchetTreeBytes = null) {
        await this.ensureReady();

        // Stage the welcome in WASM
        const stagingId = this.client.stage_welcome(welcomeBytes, ratchetTreeBytes);

        const info = this.client.get_staged_welcome_info(stagingId);
        const groupId = this.groupIdFromHex(info.group_id_hex);

        // Extract and record sender fingerprint for TOFU using signature key
        let senderFingerprintStatus = null;
        let senderFingerprint = null;
        if (info.sender?.signature_key_hex) {
            try {
                // Use signature key (not identity) for fingerprint - detects key changes
                senderFingerprint = await this.extractFingerprintFromSignatureKey(info.sender.signature_key_hex);

                if (senderFingerprint) {
                    // Identity is already a string from WASM (userId as UTF-8)
                    const senderUserId = parseInt(info.sender.identity, 10);
                    if (!isNaN(senderUserId) && senderUserId !== parseInt(this.identityName, 10)) {
                        senderFingerprintStatus = await this.recordContactFingerprint(senderUserId, senderFingerprint);
                    }
                }
            } catch (e) {
                console.warn('[MLS] Error extracting sender fingerprint in stageWelcome:', e);
            }
        }

        return {
            stagingId,
            groupId,
            ciphersuite: info.ciphersuite,
            epoch: info.epoch,
            sender: info.sender,
            members: info.members,
            senderFingerprint,
            senderFingerprintStatus
        };
    }

    getStagedWelcomeInfo(stagingId) {
        this.requireClient();
        return this.client.get_staged_welcome_info(stagingId);
    }

    async acceptStagedWelcome(stagingId) {
        this.requireClient();

        // Get welcome info before accepting (to extract member fingerprints)
        const info = this.getStagedWelcomeInfo(stagingId);

        const groupIdBytes = this.client.accept_staged_welcome(stagingId);
        const groupId = this.groupIdFromBytes(groupIdBytes);

        // Record fingerprints for all group members (TOFU) using signature keys
        const fingerprintWarnings = [];
        if (info.members && Array.isArray(info.members)) {
            for (const member of info.members) {
                // Use signature_key_hex for fingerprinting (detects key changes)
                if (!member?.signature_key_hex) continue;

                try {
                    // Identity is already a string from WASM (userId as UTF-8)
                    const memberUserId = parseInt(member.identity, 10);

                    // Skip self and invalid IDs
                    if (isNaN(memberUserId) || memberUserId === parseInt(this.identityName, 10)) {
                        continue;
                    }

                    const fingerprint = await this.extractFingerprintFromSignatureKey(member.signature_key_hex);
                    if (fingerprint) {
                        const result = await this.recordContactFingerprint(memberUserId, fingerprint);
                        if (result.changed) {
                            fingerprintWarnings.push({
                                userId: memberUserId,
                                previousFingerprint: result.previousFingerprint,
                                currentFingerprint: fingerprint
                            });
                        }
                    }
                } catch (e) {
                    console.warn('[MLS] Error extracting member fingerprint:', e);
                }
            }
        }

        // Store warnings in messagingStore for UI display
        if (fingerprintWarnings.length > 0) {
            console.warn('[MLS] SECURITY: Fingerprint changes detected for members:', fingerprintWarnings);
            // Notify UI about fingerprint changes
            try {
                const { default: messagingStore } = await import('../../stores/messagingStore.js');
                messagingStore.addFingerprintWarnings(fingerprintWarnings);
            } catch (e) {
                console.warn('[MLS] Could not notify UI of fingerprint warnings:', e);
            }
        }

        // Save state
        await this.saveState();

        // Regenerate KeyPackage (it was consumed)
        await this.regenerateKeyPackage();

        // Sync members
        try {
            await this.syncGroupMembers(groupId);
        } catch (e) {
            console.warn('[MLS] Failed to sync group members:', e);
        }

        await this._broadcastGroupConfirmationTag(groupId, 'after welcome acceptance');

        return groupId;
    }

    rejectStagedWelcome(stagingId) {
        this.requireClient();
        this.client.reject_staged_welcome(stagingId);
    }

    listStagedWelcomes() {
        if (!this.client) return [];
        return Array.from(this.client.list_staged_welcomes() || []);
    }

    validateStagedWelcomeMembers(stagingId, validator) {
        const info = this.getStagedWelcomeInfo(stagingId);
        const groupId = this.groupIdFromHex(info.group_id_hex);
        const invalidMembers = [];
        const issues = [];
        const defaultValidator = (member) => {
            if (!member || !member.is_basic_credential) return false;
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

    async regenerateKeyPackage() {
        this.requireClient();
        this.client.regenerate_key_package();
        await this.ensureKeyPackagesFresh();
    }

    async sendMessage(groupId, plaintext) {
        await this.ensureReady();
        const { bytes: groupIdBytes, str: groupIdValue } = this.normalizeGroupId(groupId);
        await this.requireDeviceId('Device ID not available. Unlock or set up your keystore first.');

        const plaintextBytes = new TextEncoder().encode(plaintext);
        this.setGroupAad(groupIdValue, 'application');
        let ciphertextBytes;
        try {
            ciphertextBytes = this.client.encrypt_message(groupIdBytes, plaintextBytes);
        } catch (e) {
            const msg = String(e?.message || e || '');
            if (/group/i.test(msg) && /not found/i.test(msg)) {
                throw new Error('This conversation is not available on this device (group state missing). Accept the pending invite or link this device to recover your messaging state.');
            }
            throw e;
        }

        const result = await this.mlsFetch('/messages/group', {
            groupId: groupIdValue,
            messageType: 'application',
            data: this.toPostgresHex(ciphertextBytes)
        });
        const messageId = result.queueId || result.id;

        try {
            this.client.store_sent_message(groupIdBytes, String(messageId), plaintext);
            await this.saveState();
            const vault = await this.getVaultService();
            await vault.persistMessage({
                id: messageId, groupId: groupIdValue,
                senderId: this.identityName || localStorage.getItem('userId'),
                plaintext, type: 'application', timestamp: new Date().toISOString()
            });
        } catch (e) {
            console.warn('[MLS] Failed to store sent message:', e);
        }
        return { ...result, id: messageId };
    }

    async sendSystemMessage(groupId, payload) {
        await this.ensureReady();
        const { bytes: groupIdBytes, str: groupIdValue } = this.normalizeGroupId(groupId);
        await this.requireDeviceId('Device ID not available. Unlock or set up your keystore first.');

        const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
        this.setGroupAad(groupIdValue, 'application');
        const ciphertextBytes = this.client.encrypt_message(groupIdBytes, new TextEncoder().encode(plaintext));

        return this.mlsFetch('/messages/group', {
            groupId: groupIdValue,
            messageType: 'application',
            data: this.toPostgresHex(ciphertextBytes)
        });
    }

    // Key rotation for Post-Compromise Security
    async selfUpdate(groupId) {
        await this.ensureReady();
        const { bytes: groupIdBytes, str: groupIdValue } = this.normalizeGroupId(groupId);
        await this.requireDeviceId('Device ID not available');

        const rollbackState = await this.exportStateForVault();
        this.setGroupAad(groupIdValue, 'commit');
        const result = this.client.self_update(groupIdBytes);
        if (!result?.length) throw new Error('self_update returned invalid result');

        const commitBytes = result[0];
        const epoch = this.getGroupEpoch(groupId);

        await this._sendGroupCommit({
            groupId: groupIdValue,
            commitBytes,
            epoch,
            rollbackState,
            context: 'self update'
        });
        await this.saveState();
        await this._broadcastGroupConfirmationTag(groupIdValue, 'after self update');
        return { success: true };
    }

    // Rotate keys for all active groups
    async rotateKeysAllGroups() {
        const { default: messagingStore } = await import('../../stores/messagingStore.js');
        const groupsToUpdate = [];

        if (messagingStore.mlsGroups) {
            groupsToUpdate.push(...messagingStore.mlsGroups.map(g => g.group_id || g.id));
        }
        if (messagingStore.directMessages) {
            groupsToUpdate.push(...messagingStore.directMessages.map(dm => dm.group_id || dm.id));
        }

        const uniqueGroups = [...new Set(groupsToUpdate)].filter(Boolean);
        if (uniqueGroups.length === 0) return { successCount: 0, failCount: 0 };

        console.log(`[MLS] Rotating keys for ${uniqueGroups.length} groups...`);
        let successCount = 0;
        let failCount = 0;

        for (const groupId of uniqueGroups) {
            try {
                await this.selfUpdate(groupId);
                successCount++;
            } catch (err) {
                console.warn(`[MLS] Failed to rotate keys for group ${groupId}:`, err);
                failCount++;
            }
        }

        console.log(`[MLS] Key rotation complete. Success: ${successCount}, Failed: ${failCount}`);

        if (successCount === 0 && failCount > 0) {
            throw new Error(`Failed to rotate keys for ${failCount} conversations.`);
        }

        return { successCount, failCount };
    }

    async removeMember(groupId, leafIndex) {
        await this.ensureReady();
        const { bytes: groupIdBytes, str: groupIdValue } = this.normalizeGroupId(groupId);
        await this.requireDeviceId('Device ID not available');

        const rollbackState = await this.exportStateForVault();
        this.setGroupAad(groupIdValue, 'commit');
        const result = this.client.remove_member(groupIdBytes, leafIndex);
        if (!result?.length) throw new Error('remove_member returned invalid result');

        const commitBytes = result[0];
        const epoch = this.getGroupEpoch(groupId);

        await this._sendGroupCommit({
            groupId: groupIdValue,
            commitBytes,
            epoch,
            rollbackState,
            context: 'member removal'
        });
        await this.syncGroupMembers(groupIdValue);
        await this.saveState();
        await this._broadcastGroupConfirmationTag(groupIdValue, 'after member removal');
        return { success: true };
    }

    async leaveGroup(groupId) {
        await this.ensureReady();
        const { bytes: groupIdBytes, str: groupIdValue } = this.normalizeGroupId(groupId);

        this.setGroupAad(groupIdValue, 'proposal');
        const proposalBytes = this.client.leave_group(groupIdBytes);

        const result = await this.mlsFetch('/messages/group', {
            groupId: groupIdValue, messageType: 'proposal', data: this.toPostgresHex(proposalBytes)
        });
        await this.saveState();
        return result;
    }

    getOwnLeafIndex(groupId) {
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        return this.client.get_own_leaf_index(groupIdBytes);
    }

    getGroupConfirmationTag(groupId) {
        this.requireClient();
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

    async _sendGroupCommit({
        groupId,
        commitBytes,
        epoch,
        rollbackState = null,
        excludeUserIds = null,
        mergePendingCommit = true,
        context = '',
        onCommitFailure
    }) {
        const normalized = this.normalizeGroupId(groupId);
        const payload = {
            groupId: normalized.str,
            epoch,
            messageType: 'commit',
            data: this.toPostgresHex(commitBytes)
        };

        if (excludeUserIds?.length > 0) {
            payload.excludeUserIds = excludeUserIds;
        }

        try {
            await this.mlsFetch('/messages/group', payload);
        } catch (commitErr) {
            if (mergePendingCommit) {
                try { this.client.clear_pending_commit(normalized.bytes); } catch (e) { }
            }

            if (rollbackState) {
                await this.restoreStateFromVault(rollbackState);
            }
            if (onCommitFailure) {
                await onCommitFailure();
            }

            throw commitErr;
        }

        if (mergePendingCommit) {
            try {
                this.client.merge_pending_commit(normalized.bytes);
            } catch (mergeErr) {
                console.warn(`[MLS] Failed to merge pending commit${context ? ` for ${context}` : ''}:`, mergeErr);
                throw mergeErr;
            }
        }

        return normalized.str;
    }

    async _broadcastGroupConfirmationTag(groupId, context = '') {
        try {
            const currentEpoch = this.getGroupEpoch(groupId);
            await this.broadcastConfirmationTag(groupId, currentEpoch);
        } catch (tagErr) {
            console.warn(`[MLS] Failed to broadcast confirmation tag${context ? ` ${context}` : ''}:`, tagErr);
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

    decryptMessage(groupId, ciphertext) {
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        const ciphertextBytes = this._toBytes(ciphertext);
        const result = this.client.decrypt_message_with_aad(groupIdBytes, ciphertextBytes);
        const plaintextBytes = new Uint8Array(result.plaintext || []);
        const aadHex = result.aad_hex || '';
        const aadBytes = aadHex ? this.hexToBytes(aadHex) : new Uint8Array();
        const epoch = typeof result.epoch === 'bigint' ? Number(result.epoch) : result.epoch;

        const plaintext = new TextDecoder().decode(plaintextBytes);

        return {
            plaintext,
            aadBytes,
            aadHex,
            epoch
        };
    }

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

        const vault = await this.getVaultService();
        const deviceId = vault.getDeviceId();
        if (!deviceId) return [];

        if (this.processedMessageIds.size === 0) {
            await this.loadProcessedIDs();
        }

        try {
            const pending = await api.mls.getPendingMessages();
            if (!pending || pending.length === 0) return [];

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
                        const welcomeBytes = this._toBytes(msg.data);
                        if (!welcomeBytes) {
                            console.warn('[MLS] Invalid welcome data format');
                            continue;
                        }
                        const groupInfoBytes = this._toBytes(msg.group_info);

                        const staged = await this.stageWelcome(welcomeBytes, null);
                        const validation = this.validateStagedWelcomeMembers(staged.stagingId);

                        if (!validation.valid) {
                            console.warn('[MLS] Staged welcome failed validation:', validation.issues);
                            this.rejectStagedWelcome(staged.stagingId);
                            this.markProcessed(messageId);
                            continue;
                        }

                        // Check if current user follows the sender - auto-accept if so
                        let followsSender = false;
                        if (msg.sender_user_id) {
                            try {
                                const followRes = await fetch(`/api/users/${msg.sender_user_id}/following-status`, {
                                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
                                });
                                if (followRes.ok) {
                                    const followData = await followRes.json();
                                    followsSender = followData.isFollowing === true;
                                    console.log('[MLS] Sender follow status:', { senderUserId: msg.sender_user_id, followsSender });
                                }
                            } catch (e) {
                                console.warn('[MLS] Could not check follow status:', e);
                            }
                        }

                        let welcomeOutcome = followsSender ? 'accepted' : 'pending';
                        if (messageId) {
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

                            // Only invoke handlers if outcome is 'pending' (not auto-accepted)
                            // Handlers can override the decision or display UI for user confirmation
                            if (welcomeOutcome === 'pending') {
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
                                }
                                // If no explicit decision from handlers, keep pending
                            }
                        }

                        if (welcomeOutcome === 'accepted') {
                            const groupId = await this.acceptStagedWelcome(staged.stagingId);
                            this.pendingWelcomes.delete(messageId);
                            this.welcomeHandlers.forEach(h => h({ groupId, groupInfoBytes }));
                            this.markProcessed(messageId);
                        } else if (welcomeOutcome === 'rejected') {
                            this.rejectStagedWelcome(staged.stagingId);
                            this.pendingWelcomes.delete(messageId);
                            this.markProcessed(messageId);
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

    async handleIncomingMessage(messageData) {
        this.requireClient();

        const { group_id, data, content_type, sender_id, sender_user_id, id } = messageData;
        const senderUserId = sender_user_id || sender_id;

        // Skip already processed messages (deduplication)
        if (id && this.processedMessageIds.has(id)) {
            return { id, groupId: group_id, senderId: sender_id, type: 'duplicate', skipped: true };
        }

        if (content_type === 'application') {
            // Note: sender_id is now senderDeviceId.
            // To check if it's own message, we compare with our own deviceId.
            const vault = await this.getVaultService();
            const myDeviceId = vault.getDeviceId();

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
                    this.markProcessed(id);
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

            this.markProcessed(id);

            if (plaintext && plaintext !== '[Encrypted Message]') {
                let payload = null;
                try {
                    payload = JSON.parse(plaintext);
                } catch (e) { }
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
                const vault = await this.getVaultService();
                await vault.persistMessage(messageObj);
            }

            return messageObj;
        } else if (content_type === 'proposal') {
            const proposalResult = await this.processProposal(group_id, data);
            this.markProcessed(id);
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
            this.markProcessed(id);
            return { id, groupId: group_id, senderId: senderUserId, senderDeviceId: sender_id, type: 'commit' };
        } else {
            this.markProcessed(id);
            return { id, groupId: group_id, senderId: senderUserId, senderDeviceId: sender_id, type: 'unknown' };
        }
    }

    async processCommit(groupId, commitData) {
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        const commitBytes = this._toBytes(commitData);
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

        await this._broadcastGroupConfirmationTag(groupId, 'after staged commit');

        try {
            await this.syncGroupMembers(groupId);
        } catch (syncErr) {
            console.warn('[MLS] Failed to sync group members:', syncErr);
        }

        return { accepted: true };
    }

    async processProposal(groupId, proposalData) {
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        const proposalBytes = this._toBytes(proposalData);
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
        this.requireClient();
        const groupIdBytes = this.groupIdToBytes(groupId);
        this.client.clear_pending_proposals(groupIdBytes);
    }

    async commitPendingProposals(groupId, { welcomeRecipients = [] } = {}) {
        await this.ensureReady();

        const groupIdBytes = this.groupIdToBytes(groupId);
        const rollbackState = await this.exportStateForVault();

        this.setGroupAad(groupId, 'commit');
        const result = this.client.commit_pending_proposals(groupIdBytes);
        const commitBytes = new Uint8Array(result[0] || []);
        const welcomeBytes = result[1] ? new Uint8Array(result[1]) : null;
        const groupInfoBytes = result[2] ? new Uint8Array(result[2]) : null;
        const epoch = this.getGroupEpoch(groupId);

        await this._sendGroupCommit({
            groupId,
            commitBytes,
            epoch,
            rollbackState,
            context: 'proposal batch',
        });

        await this._broadcastGroupConfirmationTag(groupId, 'after proposal batch');

        // Send welcomes with error tracking
        const failedRecipients = [];
        if (welcomeBytes && welcomeRecipients.length > 0) {
            for (const receiverId of welcomeRecipients) {
                try {
                    await this.mlsFetch('/messages/welcome', {
                        groupId, receiverId,
                        data: this.toPostgresHex(welcomeBytes),
                        groupInfo: groupInfoBytes ? this.toPostgresHex(groupInfoBytes) : null
                    });
                } catch (welcomeErr) {
                    console.warn(`[MLS] Error sending welcome to ${receiverId}:`, welcomeErr);
                    failedRecipients.push(receiverId);
                }
            }
        }

        await this.saveState();

        return { commitBytes, welcomeBytes, groupInfoBytes, failedRecipients };
    }

    async validateStagedCommit(groupId, summary) {
        if (!summary) return true;
        const adds = summary.adds || [], updates = summary.updates || [], removes = summary.removes || [];

        // Check lifetime validity
        if ([...adds, ...updates].some(e => e?.lifetime && !this.keyPackageLifetimeAcceptable(e.lifetime))) return false;
        if (adds.some(e => e && !e.lifetime)) return false;
        if ([...adds, ...updates].some(e => e?.is_basic === false)) return false;

        const current = new Set(this.getGroupMemberIdentities(groupId));
        const addIds = adds.map(e => e?.identity).filter(Boolean);
        const updateIds = updates.map(e => e?.identity).filter(Boolean);
        const removeIds = removes.map(e => e?.identity?.identity).filter(Boolean);
        if (removes.some(e => e && e.identity == null)) return false;

        const allIds = [...addIds, ...updateIds, ...removeIds];

        if (this.isDirectMessage(groupId)) {
            const allowed = new Set(this.getDmParticipantIds(groupId));
            if (allowed.size === 0 || adds.length > 1) return false;
            if (allIds.some(id => !allowed.has(String(id)))) return false;
        } else {
            if (allIds.some(id => !this.isNumericIdentity(id))) return false;
        }

        if (addIds.some(id => current.has(id))) return false;
        if (updateIds.some(id => !current.has(id))) return false;
        if (removeIds.some(id => !current.has(id))) return false;
        return true;
    }

    setupSocketListeners() {
        if (this._socketCleanup) return;
        const c1 = registerSocketEventHandler('mls-welcome', () => this.syncMessages());
        const c2 = registerSocketEventHandler('mls-message', () => this.syncMessages());
        this._socketCleanup = () => { c1(); c2(); };
        this.syncMessages();
    }

    cleanupSocketListeners() {
        if (this._socketCleanup) { this._socketCleanup(); this._socketCleanup = null; }
    }

    async exportStateForVault() {
        if (!this.client || !this.identityName) return null;

        try {
            const credential = this.client.get_credential_bytes();
            const bundle = this.client.get_key_package_bundle_bytes();
            const signatureKey = this.client.get_signature_keypair_bytes();

            return {
                credential: Array.from(credential),
                bundle: Array.from(bundle),
                signatureKey: Array.from(signatureKey),
                identityName: this.identityName,
                exportedAt: Date.now()
            };
        } catch (error) {
            console.error('[MLS] Error exporting state for vault:', error);
            return null;
        }
    }

    async restoreStateFromVault(stateObj) {
        if (!stateObj?.credential || !stateObj?.bundle || !stateObj?.signatureKey) return false;
        if (!this.initialized) await this.initialize();

        try {
            this.client = new MlsClient();
            this.client.restore_identity(
                new Uint8Array(stateObj.credential),
                new Uint8Array(stateObj.bundle),
                new Uint8Array(stateObj.signatureKey)
            );
            this.identityName = stateObj.identityName;

            try {
                const vault = await this.getVaultService();
                const events = await vault.loadGranularEvents();
                if (events?.length > 0) this.client.import_granular_events(events);
            } catch (e) { }

            this.setupSocketListeners();
            const processed = await this.syncMessages();
            if (processed.length > 0) await this.saveState();
            return true;
        } catch (error) {
            console.error('[MLS] Error restoring state from vault:', error);
            return false;
        }
    }

    async resyncGroupsFromServer() {
        try { await this.getAuthContext(); } catch { return; }

        try {
            await this.syncMessages();
            const serverGroups = await this.mlsFetch('/groups', null, { method: 'GET', skipDeviceId: true }).catch(() => null);
            if (!serverGroups) return;

            this._missingGroups = serverGroups
                .filter(g => !this.client.has_group(this.groupIdToBytes(g.group_id)))
                .map(g => ({ id: g.group_id, name: g.name }));
        } catch (e) {
            console.error('[MLS] Error re-syncing groups:', e);
        }
    }

    getMissingGroups() {
        return this._missingGroups || [];
    }

    getIdentityFingerprint() {
        if (!this.client) return null;
        try {
            return this.client.get_identity_fingerprint();
        } catch (e) {
            console.error('[MLS] Error getting fingerprint:', e);
            return null;
        }
    }

    formatFingerprint(fingerprint) {
        if (!fingerprint) return '';
        // Split into groups of 4 characters for readability
        return fingerprint.toUpperCase().match(/.{1,4}/g)?.join(' ') || fingerprint;
    }

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

    // ==================== Contact Fingerprint Methods (TOFU) ====================

    /**
     * Extract fingerprint from a user's signature key (from welcome/commit)
     * Uses SHA-256 hash of the PUBLIC SIGNATURE KEY to detect key changes
     * This is critical for TOFU - identity alone doesn't change when keys rotate
     * @param {string} signatureKeyHex - The signature public key as hex string
     * @returns {Promise<string|null>} - Hex fingerprint or null
     */
    async extractFingerprintFromSignatureKey(signatureKeyHex) {
        if (!signatureKeyHex || signatureKeyHex.length === 0) return null;
        try {
            // Convert hex string to bytes
            const keyBytes = new Uint8Array(
                signatureKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
            );
            // Hash the signature key using SHA-256 to create fingerprint
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', keyBytes);
            const hashArray = new Uint8Array(hashBuffer);
            // Convert to hex string (full 32 bytes = 64 hex chars for complete fingerprint)
            return Array.from(hashArray)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        } catch (e) {
            console.error('[MLS] Error extracting fingerprint from signature key:', e);
            return null;
        }
    }

    /**
     * @deprecated Use extractFingerprintFromSignatureKey instead
     * Kept for backwards compatibility but now delegates to signature key method
     */
    async extractFingerprintFromIdentity(identityBytes) {
        console.warn('[MLS] extractFingerprintFromIdentity is deprecated, use extractFingerprintFromSignatureKey');
        if (!identityBytes || identityBytes.length === 0) return null;
        try {
            // Hash the identity bytes using SHA-256 to create fingerprint
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', identityBytes);
            const hashArray = new Uint8Array(hashBuffer);
            // Convert to hex string (first 30 bytes = 60 hex chars)
            return Array.from(hashArray.slice(0, 30))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        } catch (e) {
            console.error('[MLS] Error extracting fingerprint from identity:', e);
            return null;
        }
    }

    /**
     * Get stored fingerprint for a contact from vault
     * @param {number} contactUserId
     * @returns {Promise<{fingerprint: string, status: string, verifiedAt: number|null}|null>}
     */
    async getContactFingerprint(contactUserId) {
        try {
            const vault = await this.getVaultService();
            return await vault.getContactFingerprint(contactUserId);
        } catch (e) {
            console.warn('[MLS] Error getting contact fingerprint:', e);
            return null;
        }
    }

    /**
     * Store a contact's fingerprint (TOFU - Trust on First Use)
     * @param {number} contactUserId
     * @param {string} fingerprint - Hex fingerprint
     * @returns {Promise<{isNew: boolean, changed: boolean, previousFingerprint?: string}>}
     */
    async recordContactFingerprint(contactUserId, fingerprint) {
        try {
            const vault = await this.getVaultService();
            const result = await vault.checkFingerprintChanged(contactUserId, fingerprint);

            if (result.isNew) {
                // First contact - TOFU
                await vault.saveContactFingerprint(contactUserId, fingerprint);
                console.log(`[MLS] TOFU: Recorded fingerprint for user ${contactUserId}`);
                return { isNew: true, changed: false };
            }

            if (result.changed) {
                // FINGERPRINT CHANGED - potential MITM!
                await vault.updateContactFingerprint(contactUserId, fingerprint, result.previousFingerprint);
                console.warn(`[MLS] WARNING: Fingerprint changed for user ${contactUserId}!`);
                return { isNew: false, changed: true, previousFingerprint: result.previousFingerprint };
            }

            // Same fingerprint - no action needed
            return { isNew: false, changed: false };
        } catch (e) {
            console.error('[MLS] Error recording contact fingerprint:', e);
            return { isNew: false, changed: false, error: e.message };
        }
    }

    /**
     * Mark a contact as verified after out-of-band comparison
     * @param {number} contactUserId
     */
    async verifyContact(contactUserId) {
        try {
            const vault = await this.getVaultService();
            await vault.setContactVerified(contactUserId, true);
            console.log(`[MLS] Contact ${contactUserId} marked as verified`);
        } catch (e) {
            console.error('[MLS] Error verifying contact:', e);
            throw e;
        }
    }

    /**
     * Unmark a contact as verified
     * @param {number} contactUserId
     */
    async unverifyContact(contactUserId) {
        try {
            const vault = await this.getVaultService();
            await vault.setContactVerified(contactUserId, false);
            console.log(`[MLS] Contact ${contactUserId} marked as unverified`);
        } catch (e) {
            console.error('[MLS] Error unverifying contact:', e);
            throw e;
        }
    }

    /**
     * Get verification status for a contact
     * @param {number} contactUserId
     * @returns {Promise<'unverified'|'verified'|'changed'>}
     */
    async getContactVerificationStatus(contactUserId) {
        try {
            const vault = await this.getVaultService();
            const record = await vault.getContactFingerprint(contactUserId);
            return record?.status || 'unverified';
        } catch (e) {
            console.warn('[MLS] Error getting verification status:', e);
            return 'unverified';
        }
    }

    /**
     * Check if a message sender's fingerprint has changed
     * Called when processing incoming messages for MITM detection
     * @param {number} senderId - Sender's user ID
     * @param {Uint8Array} senderIdentity - Sender's identity bytes
     * @returns {Promise<{warning: boolean, message?: string}>}
     */
    async checkSenderFingerprint(senderId, senderIdentity) {
        if (!senderIdentity) return { warning: false };

        try {
            const currentFingerprint = await this.extractFingerprintFromIdentity(senderIdentity);
            if (!currentFingerprint) return { warning: false };

            const result = await this.recordContactFingerprint(senderId, currentFingerprint);

            if (result.changed) {
                return {
                    warning: true,
                    senderId,
                    currentFingerprint,
                    previousFingerprint: result.previousFingerprint,
                    message: `Security warning: User ${senderId}'s encryption key has changed. ` +
                        `This could indicate a security issue. Please verify their identity.`
                };
            }

            return { warning: false };
        } catch (e) {
            console.error('[MLS] Error checking sender fingerprint:', e);
            return { warning: false };
        }
    }

    /**
     * Get all contact fingerprints for current device
     * @returns {Promise<Array>}
     */
    async getAllContactFingerprints() {
        try {
            const vault = await this.getVaultService();
            return await vault.getAllContactFingerprints();
        } catch (e) {
            console.warn('[MLS] Error getting all contact fingerprints:', e);
            return [];
        }
    }

    // ==================== End Contact Fingerprint Methods ====================

    wipeMemory() {
        this.cleanupSocketListeners();
        if (this.client) { try { this.client.free(); } catch (e) { } }
        this.client = null;
        this.identityName = null;
        this.confirmationTags.clear();
        this.remoteConfirmationTags.clear();
        this.sentConfirmationTags.clear();
        this.pendingWelcomes.clear();
        this.processedMessageIds.clear();
        this.processingMessageIds.clear();
        this.messageHandlers = [];
        this.welcomeHandlers = [];
        this.welcomeRequestHandlers = [];
        this.forkHandlers = [];
        this.commitRejectionHandlers = [];
        this.bootstrapPromise = null;
        this.bootstrapUser = null;
    }

    async clearState() {
        this.wipeMemory();
        try { indexedDB.deleteDatabase('openmls_storage'); } catch (e) { }
    }

    // Event handler registration (using factory pattern)
    onMessage(cb) { return this._createHandler(this.messageHandlers)(cb); }
    onWelcome(cb) { return this._createHandler(this.welcomeHandlers)(cb); }
    onWelcomeRequest(cb) { return this._createHandler(this.welcomeRequestHandlers)(cb); }
    onForkDetected(cb) { return this._createHandler(this.forkHandlers)(cb); }
    onCommitRejected(cb) { return this._createHandler(this.commitRejectionHandlers)(cb); }
    emitForkDetected(details) { this._emit(this.forkHandlers, details); }
    emitCommitRejected(details) { this._emit(this.commitRejectionHandlers, details); }

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

        // Ack first so server registers us as member before any messages are sent
        await api.mls.ackMessages([pendingId]);
        this.markProcessed(pendingId);
        this.pendingWelcomes.delete(pendingId);

        const groupId = await this.acceptStagedWelcome(stagingId);
        this.welcomeHandlers.forEach(h => h({ groupId, groupInfoBytes: record.groupInfoBytes }));
        this.syncMessages().catch(() => { });
        return groupId;
    }

    async inspectPendingWelcome(pending) {
        if (!pending) throw new Error('Pending welcome required');
        const pendingId = typeof pending === 'object' ? pending.id : pending;
        if (!pendingId) throw new Error('Pending welcome id missing');

        let record = this.pendingWelcomes.get(pendingId);
        if (!record && typeof pending === 'object' && pending.welcomeHex) {
            record = {
                id: pendingId,
                welcomeBytes: this.hexToBytes(pending.welcomeHex),
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
            if (this.pendingWelcomes.has(record.id)) {
                const updated = this.pendingWelcomes.get(record.id);
                updated.stagingId = stagingId;
            }
        }

        return this.getStagedWelcomeInfo(stagingId);
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
        this.markProcessed(pendingId);
    }

    async fetchAndDecryptMessages(groupId) {
        if (!this.initialized) await this.initialize();
        if (!this.client) return [];

        try {
            const messages = await this.mlsFetch(`/messages/group/${encodeURIComponent(groupId)}`, null, { method: 'GET', skipDeviceId: true });
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

const coreCryptoClient = new CoreCryptoClient();

// Expose to window for E2E testing
if (typeof window !== 'undefined') {
    window.coreCryptoClient = coreCryptoClient;
}

export default coreCryptoClient;
