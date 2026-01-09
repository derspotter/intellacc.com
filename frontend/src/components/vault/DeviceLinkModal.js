import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';
import api from '../../services/api.js';

const { div, h2, h3, p, button, span, code, strong } = van.tags;

// Module-level state to prevent race conditions across component re-renders
// These are singleton because DeviceLinkModal is only rendered once in MainLayout
const status = van.state('init'); // 'init', 'loading', 'waiting', 'approved', 'error'
const linkToken = van.state('');
const expiresAt = van.state(null);
const error = van.state('');
const pollInterval = van.state(null);
const timeRemaining = van.state('');

let moduleState = {
    linkingStarted: false,
    lastModalVisible: false,
    deriveInitialized: false,
    countdownTimer: null  // Track countdown timer for cleanup
};

// Generate a device ID for this new device (module-level, generated once)
// Note: We always re-sync to localStorage in case it was cleared after module load
const devicePublicId = (() => {
    let id = localStorage.getItem('device_public_id');
    if (!id) {
        id = window.crypto?.randomUUID ? window.crypto.randomUUID() : `dev-${Date.now()}`;
        localStorage.setItem('device_public_id', id);
    }
    return id;
})();

// Ensure device_public_id is in localStorage (re-sync if cleared)
const ensureDeviceIdInStorage = () => {
    if (localStorage.getItem('device_public_id') !== devicePublicId) {
        localStorage.setItem('device_public_id', devicePublicId);
    }
};

/**
 * Modal for device verification/linking flow
 * Shown when user logs in from a new device that needs to be verified
 */
export default function DeviceLinkModal({ onSuccess } = {}) {

    // Start the linking process
    const startLinking = async () => {
        console.log('[DeviceLink] Starting linking process...');
        status.val = 'loading';
        error.val = '';

        // Ensure device_public_id is in localStorage (may have been cleared after module load)
        ensureDeviceIdInStorage();

        try {
            console.log('[DeviceLink] Calling API with device:', devicePublicId);
            const result = await api.devices.startLinking(devicePublicId, getDeviceName());
            console.log('[DeviceLink] Got token:', result.token);
            linkToken.val = result.token;
            expiresAt.val = new Date(result.expires_at);
            vaultStore.setDeviceLinkToken(result.token, result.expires_at);

            status.val = 'waiting';
            console.log('[DeviceLink] Status set to waiting');
            startPolling();
            updateTimeRemaining();
        } catch (e) {
            console.error('[DeviceLink] Failed to start linking:', e);
            error.val = e.message || 'Failed to start device verification';
            status.val = 'error';
        }
    };

    // Poll for approval status
    const startPolling = () => {
        if (pollInterval.val) clearInterval(pollInterval.val);

        const interval = setInterval(async () => {
            try {
                const result = await api.devices.getLinkingStatus(linkToken.val);
                if (result.approved) {
                    clearInterval(interval);
                    pollInterval.val = null;
                    status.val = 'approved';
                    handleApproved();
                }
            } catch (e) {
                // Ignore polling errors, keep trying
                console.warn('[DeviceLink] Polling error:', e);
            }
        }, 3000); // Poll every 3 seconds

        pollInterval.val = interval;
    };

    // Update countdown timer
    const updateTimeRemaining = () => {
        // Clear any existing timer first
        if (moduleState.countdownTimer) {
            clearInterval(moduleState.countdownTimer);
            moduleState.countdownTimer = null;
        }

        const update = () => {
            if (!expiresAt.val) return;
            const now = new Date();
            const diff = expiresAt.val - now;
            if (diff <= 0) {
                timeRemaining.val = 'Expired';
                status.val = 'error';
                error.val = 'Verification code expired. Please try again.';
                if (pollInterval.val) {
                    clearInterval(pollInterval.val);
                    pollInterval.val = null;
                }
                // Clear countdown timer
                if (moduleState.countdownTimer) {
                    clearInterval(moduleState.countdownTimer);
                    moduleState.countdownTimer = null;
                }
                return;
            }
            const mins = Math.floor(diff / 60000);
            const secs = Math.floor((diff % 60000) / 1000);
            timeRemaining.val = `${mins}:${secs.toString().padStart(2, '0')}`;
        };
        update();
        moduleState.countdownTimer = setInterval(update, 1000);
    };

    // Clean up all timers
    const cleanupTimers = () => {
        if (pollInterval.val) {
            clearInterval(pollInterval.val);
            pollInterval.val = null;
        }
        if (moduleState.countdownTimer) {
            clearInterval(moduleState.countdownTimer);
            moduleState.countdownTimer = null;
        }
    };

    // Handle successful approval
    const handleApproved = async () => {
        try {
            // Close the modal
            vaultStore.setShowDeviceLinkModal(false);

            // Now the device is verified, retry vault setup
            if (onSuccess) {
                await onSuccess();
            }
        } catch (e) {
            console.error('[DeviceLink] Error after approval:', e);
        }
    };

    // Cancel and close
    const handleCancel = () => {
        cleanupTimers();
        vaultStore.setShowDeviceLinkModal(false);
    };

    // Get device name for display
    const getDeviceName = () => {
        const ua = navigator.userAgent;
        if (/iPhone/.test(ua)) return 'iPhone';
        if (/iPad/.test(ua)) return 'iPad';
        if (/Android/.test(ua)) return 'Android Device';
        if (/Mac/.test(ua)) return 'Mac';
        if (/Windows/.test(ua)) return 'Windows PC';
        if (/Linux/.test(ua)) return 'Linux PC';
        return 'New Device';
    };

    // Format token for display (groups of 4)
    const formatToken = (token) => {
        if (!token) return '';
        // Take first 12 chars and format as XXX-XXX-XXX-XXX
        const short = token.slice(0, 12).toUpperCase();
        return short.match(/.{1,3}/g)?.join('-') || short;
    };

    // Copy token to clipboard
    const copyToken = async () => {
        try {
            await navigator.clipboard.writeText(formatToken(linkToken.val));
        } catch (e) {
            console.warn('[DeviceLink] Copy failed:', e);
        }
    };

    // Initialize derive only once per module lifecycle
    if (!moduleState.deriveInitialized) {
        moduleState.deriveInitialized = true;

        // Use van.derive() to trigger startLinking when modal opens
        // Only watch showDeviceLinkModal, NOT status (to avoid re-triggering on status change)
        van.derive(() => {
            const isVisible = vaultStore.showDeviceLinkModal;

            // Detect modal opening (transition from hidden to visible)
            if (isVisible && !moduleState.lastModalVisible) {
                moduleState.lastModalVisible = true;
                // Only start linking if not already started and status is init
                if (!moduleState.linkingStarted && status.val === 'init') {
                    moduleState.linkingStarted = true;
                    // Use setTimeout to ensure we're fully outside any render cycle
                    setTimeout(() => {
                        console.log('[DeviceLink] Derive triggered startLinking');
                        startLinking();
                    }, 0);
                }
            } else if (!isVisible && moduleState.lastModalVisible) {
                // Modal closing - reset state and cleanup timers
                moduleState.lastModalVisible = false;
                moduleState.linkingStarted = false;
                cleanupTimers();
                status.val = 'init';
                linkToken.val = '';
                error.val = '';
                timeRemaining.val = '';
            }
        });
    }

    return () => {
        if (!vaultStore.showDeviceLinkModal) {
            return null;
        }

        return div({ class: 'modal-overlay' },
            div({ class: 'modal-content device-link-modal' },
                div({ class: 'modal-header' },
                    span({ class: 'modal-icon' }, '\uD83D\uDD10'),
                    h2('Verify This Device')
                ),

                // Modal body with single reactive binding for all state-dependent content
                () => {
                    const currentStatus = status.val;
                    const currentError = error.val;
                    const currentToken = linkToken.val;
                    const currentTimeRemaining = timeRemaining.val;

                    return div({ class: 'modal-body' },
                        // Loading state
                        currentStatus === 'loading' ? div({ class: 'loading-state' },
                            p('Starting device verification...')
                        ) : null,

                        // Waiting for approval
                        currentStatus === 'waiting' ? div({ class: 'waiting-state' },
                            p({ class: 'description' },
                                'This device needs to be verified before you can access your encrypted messages. ' +
                                'Enter this code on a device where you\'re already logged in:'
                            ),

                            div({ class: 'verification-code-display' },
                                code({ class: 'verification-code' }, formatToken(currentToken)),
                                button({
                                    type: 'button',
                                    class: 'btn btn-sm btn-copy',
                                    onclick: copyToken,
                                    title: 'Copy code'
                                }, '\uD83D\uDCCB')
                            ),

                            div({ class: 'expiry-timer' },
                                span('Expires in: '),
                                strong(currentTimeRemaining)
                            ),

                            div({ class: 'instructions' },
                                h3('How to verify:'),
                                div({ class: 'instruction-step' },
                                    span({ class: 'step-num' }, '1'),
                                    span('Open the app on a device where you\'re already logged in')
                                ),
                                div({ class: 'instruction-step' },
                                    span({ class: 'step-num' }, '2'),
                                    span('Go to Settings > Devices')
                                ),
                                div({ class: 'instruction-step' },
                                    span({ class: 'step-num' }, '3'),
                                    span('Tap "Approve New Device" and enter this code')
                                )
                            ),

                            p({ class: 'waiting-indicator' },
                                span({ class: 'spinner' }),
                                ' Waiting for approval...'
                            )
                        ) : null,

                        // Approved state
                        currentStatus === 'approved' ? div({ class: 'approved-state' },
                            span({ class: 'success-icon' }, '\u2713'),
                            p('Device verified successfully!')
                        ) : null,

                        // Error state
                        (currentStatus === 'error' || currentError) ? div({ class: 'error-state' },
                            p({ class: 'error-message' }, currentError || 'An error occurred'),
                            button({
                                type: 'button',
                                class: 'button button-primary',
                                onclick: () => {
                                    // Reset state and restart linking directly
                                    status.val = 'init';
                                    error.val = '';
                                    moduleState.linkingStarted = false;
                                    // Trigger startLinking directly since derive only watches visibility
                                    setTimeout(() => {
                                        moduleState.linkingStarted = true;
                                        startLinking();
                                    }, 0);
                                }
                            }, 'Try Again')
                        ) : null,

                        // Init state fallback (should briefly show while startLinking is called)
                        currentStatus === 'init' ? div({ class: 'loading-state' },
                            p('Initializing device verification...')
                        ) : null
                    );
                },

                div({ class: 'modal-footer' },
                    button({
                        type: 'button',
                        class: 'button button-secondary',
                        onclick: handleCancel
                    }, 'Cancel'),

                    p({ class: 'text-muted small' },
                        'You can skip this to browse without encrypted messaging.'
                    )
                )
            )
        );
    };
}
