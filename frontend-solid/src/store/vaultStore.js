// frontend-solid/src/store/vaultStore.js
// Vault state management for encrypted storage at rest
// SolidJS port of master's VanX reactive vaultStore

import { createStore } from "solid-js/store";

const [state, setState] = createStore({
    // Lock state
    isLocked: true,
    vaultExists: false,

    // Auto-lock settings
    autoLockMinutes: 15,
    lastActivity: Date.now(),

    // Modal visibility
    showUnlockModal: false,
    showSetupModal: false,
    showMigrationModal: false,
    showDeviceLinkModal: false,

    // Error state
    unlockError: '',
    setupError: '',

    // Device linking state
    deviceLinkToken: null,
    deviceLinkExpiry: null,
    deviceLinkError: '',

    // User context
    userId: null,
});

const vaultStore = {
    // Direct property access (getters for compatibility with master's vaultStore.isLocked pattern)
    get isLocked() { return state.isLocked; },
    get vaultExists() { return state.vaultExists; },
    get autoLockMinutes() { return state.autoLockMinutes; },
    get lastActivity() { return state.lastActivity; },
    get showUnlockModal() { return state.showUnlockModal; },
    get showSetupModal() { return state.showSetupModal; },
    get showMigrationModal() { return state.showMigrationModal; },
    get showDeviceLinkModal() { return state.showDeviceLinkModal; },
    get unlockError() { return state.unlockError; },
    get setupError() { return state.setupError; },
    get deviceLinkToken() { return state.deviceLinkToken; },
    get deviceLinkExpiry() { return state.deviceLinkExpiry; },
    get deviceLinkError() { return state.deviceLinkError; },
    get userId() { return state.userId; },

    // Expose raw state for SolidJS reactive UI components
    state,

    // Methods (match master's API exactly)
    setLocked(locked) {
        setState('isLocked', locked);
        if (!locked) {
            setState('showUnlockModal', false);
            setState('unlockError', '');
        }
    },

    setVaultExists(exists) {
        setState('vaultExists', exists);
    },

    setAutoLockMinutes(minutes) {
        setState('autoLockMinutes', Math.max(0, Math.min(60, minutes)));
    },

    updateActivity() {
        setState('lastActivity', Date.now());
    },

    setShowUnlockModal(show) {
        setState('showUnlockModal', show);
        if (show) {
            setState('unlockError', '');
        }
    },

    setShowSetupModal(show) {
        setState('showSetupModal', show);
        if (show) {
            setState('setupError', '');
        }
    },

    setShowMigrationModal(show) {
        setState('showMigrationModal', show);
    },

    setShowDeviceLinkModal(show) {
        setState('showDeviceLinkModal', show);
        if (show) {
            setState('deviceLinkError', '');
        }
    },

    setDeviceLinkToken(token, expiresAt) {
        setState('deviceLinkToken', token);
        setState('deviceLinkExpiry', expiresAt ? new Date(expiresAt) : null);
    },

    setDeviceLinkError(error) {
        setState('deviceLinkError', error);
    },

    setUnlockError(error) {
        setState('unlockError', error);
    },

    setSetupError(error) {
        setState('setupError', error);
    },

    setUserId(userId) {
        setState('userId', userId);
    },

    shouldAutoLock() {
        if (state.isLocked) return false;
        if (state.autoLockMinutes <= 0) return false;

        const idleMs = Date.now() - state.lastActivity;
        const timeoutMs = state.autoLockMinutes * 60 * 1000;
        return idleMs >= timeoutMs;
    },

    reset() {
        setState({
            isLocked: true,
            vaultExists: false,
            showUnlockModal: false,
            showSetupModal: false,
            showMigrationModal: false,
            showDeviceLinkModal: false,
            unlockError: '',
            setupError: '',
            deviceLinkToken: null,
            deviceLinkExpiry: null,
            deviceLinkError: '',
            userId: null,
            lastActivity: Date.now(),
        });
    }
};

// Expose for debugging
try {
    if (typeof window !== 'undefined') {
        window.__vaultStore = vaultStore;
    }
} catch {}

export default vaultStore;
