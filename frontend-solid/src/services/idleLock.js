// frontend-solid/src/services/idleLock.js
// Idle detection for automatic vault locking
// Copied from master with import path fixes

import vaultStore from '../store/vaultStore.js';
import vaultService from './mls/vaultService.js';

let idleCheckInterval = null;
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll', 'mousemove'];

/**
 * Handle user activity - reset the idle timer
 */
function handleActivity() {
    vaultStore.updateActivity();
}

/**
 * Check if the vault should be auto-locked due to inactivity
 */
async function checkIdleLock() {
    if (vaultStore.shouldAutoLock()) {
        console.log('[IdleLock] Auto-locking vault due to inactivity');
        await vaultService.lockKeys();
        vaultStore.setShowUnlockModal(true);
    }
}

/**
 * Initialize idle auto-lock detection
 * Call this after login to start monitoring user activity
 */
export function initIdleAutoLock() {
    // Clean up any existing listeners
    stopIdleAutoLock();

    // Add activity listeners
    ACTIVITY_EVENTS.forEach(event => {
        document.addEventListener(event, handleActivity, { passive: true });
    });

    // Check for idle lock every 30 seconds
    idleCheckInterval = setInterval(checkIdleLock, 30000);

    // Initial activity timestamp
    vaultStore.updateActivity();

    console.log('[IdleLock] Initialized');
}

/**
 * Stop idle auto-lock detection
 * Call this on logout
 */
export function stopIdleAutoLock() {
    // Remove activity listeners
    ACTIVITY_EVENTS.forEach(event => {
        document.removeEventListener(event, handleActivity);
    });

    // Clear interval
    if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
        idleCheckInterval = null;
    }

    console.log('[IdleLock] Stopped');
}

/**
 * Configure the auto-lock timeout
 * @param {number} minutes - Minutes of inactivity before locking (0 = disabled)
 */
export function configureIdleAutoLock(minutes) {
    vaultStore.setAutoLockMinutes(minutes);

    // Persist to localStorage
    try {
        localStorage.setItem('vault_autolock_minutes', String(minutes));
    } catch {}

    console.log('[IdleLock] Configured for', minutes, 'minutes');
}

/**
 * Load saved auto-lock configuration
 */
export function loadIdleLockConfig() {
    try {
        const saved = localStorage.getItem('vault_autolock_minutes');
        if (saved !== null) {
            const minutes = parseInt(saved, 10);
            if (!isNaN(minutes) && minutes >= 0) {
                vaultStore.setAutoLockMinutes(minutes);
            }
        }
    } catch {}
}

export default {
    initIdleAutoLock,
    stopIdleAutoLock,
    configureIdleAutoLock,
    loadIdleLockConfig
};
