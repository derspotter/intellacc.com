// frontend/src/stores/vaultStore.js
// Vault state management for encrypted storage at rest

import * as vanX from 'vanjs-ext';

/**
 * Vault store using VanX reactive patterns
 * Manages encryption-at-rest state for MLS cryptographic material
 */
const vaultStore = vanX.reactive({
    // Lock state
    isLocked: true,              // Whether the vault is locked (keys wiped from memory)
    vaultExists: false,          // Whether a vault has been set up for this user

    // Auto-lock settings
    autoLockMinutes: 15,         // Auto-lock timeout in minutes (0 = disabled)
    lastActivity: Date.now(),    // Timestamp of last user activity

    // Modal visibility
    showUnlockModal: false,      // Show passphrase entry modal
    showSetupModal: false,       // Show first-time setup modal
    showMigrationModal: false,   // Show password migration modal (unlock failed but vaults exist)

    // Error state
    unlockError: '',             // Error message from failed unlock attempt
    setupError: '',              // Error message from failed setup

    // User context
    userId: null,                // Current user ID (for per-user vaults)

    // Methods
    setLocked(locked) {
        vaultStore.isLocked = locked;
    },

    setVaultExists(exists) {
        vaultStore.vaultExists = exists;
    },

    setAutoLockMinutes(minutes) {
        vaultStore.autoLockMinutes = Math.max(0, Math.min(60, minutes));
    },

    updateActivity() {
        vaultStore.lastActivity = Date.now();
    },

    setShowUnlockModal(show) {
        vaultStore.showUnlockModal = show;
        if (show) {
            vaultStore.unlockError = '';
        }
    },

    setShowSetupModal(show) {
        vaultStore.showSetupModal = show;
        if (show) {
            vaultStore.setupError = '';
        }
    },

    setShowMigrationModal(show) {
        vaultStore.showMigrationModal = show;
    },

    setUnlockError(error) {
        vaultStore.unlockError = error;
    },

    setSetupError(error) {
        vaultStore.setupError = error;
    },

    setUserId(userId) {
        vaultStore.userId = userId;
    },

    /**
     * Check if auto-lock should trigger
     * @returns {boolean} True if should auto-lock
     */
    shouldAutoLock() {
        if (vaultStore.isLocked) return false;
        if (vaultStore.autoLockMinutes <= 0) return false;

        const idleMs = Date.now() - vaultStore.lastActivity;
        const timeoutMs = vaultStore.autoLockMinutes * 60 * 1000;
        return idleMs >= timeoutMs;
    },

    /**
     * Reset state (on logout)
     */
    reset() {
        vaultStore.isLocked = true;
        vaultStore.vaultExists = false;
        vaultStore.showUnlockModal = false;
        vaultStore.showSetupModal = false;
        vaultStore.showMigrationModal = false;
        vaultStore.unlockError = '';
        vaultStore.setupError = '';
        vaultStore.userId = null;
        vaultStore.lastActivity = Date.now();
    }
});

// Expose for debugging
try {
    if (typeof window !== 'undefined') {
        window.__vaultStore = vaultStore;
    }
} catch {}

export default vaultStore;
