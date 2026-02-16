import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import api from '../../services/api.js';
import { clearPendingDeviceId, getPendingDeviceId, setPendingDeviceId } from '../../services/deviceIdStore.js';

const { div, h2, h3, p, button, span, strong } = van.tags;

// Module-level state to prevent race conditions across component re-renders
// These are singleton because DeviceLinkModal is only rendered once in MainLayout
const status = van.state('init'); // 'init', 'loading', 'waiting', 'approved', 'error'
const linkToken = van.state('');
const devicePublicIdState = van.state('');
const expiresAt = van.state(null);
const error = van.state('');
const pollInterval = van.state(null);
const timeRemaining = van.state('');
let moduleState = {
    linkingStarted: false,
    lastModalVisible: false,
    countdownTimer: null
};

const getDevicePublicId = () => {
    let id = getPendingDeviceId();
    if (!id) {
        id = window.crypto?.randomUUID ? window.crypto.randomUUID() : `dev-${Date.now()}`;
        setPendingDeviceId(id);
    }
    return id;
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

        try {
            const devicePublicId = getDevicePublicId();
            console.log('[DeviceLink] Calling API with device:', devicePublicId);
            const result = await api.devices.startLinking(devicePublicId, getDeviceName());
            console.log('[DeviceLink] Got token:', result.token);
            linkToken.val = result.token;
            devicePublicIdState.val = devicePublicId;
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
            moduleState.linkingStarted = false;
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
            cleanupTimers();
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
        resetModalState();
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

    // Show linking token in full so users can copy accurately on the second device
    const formatToken = (token) => {
        if (!token) return '';
        return token.toUpperCase();
    };

    // Copy token to clipboard
    const copyToken = async () => {
        try {
            await navigator.clipboard.writeText(linkToken.val);
        } catch (e) {
            console.warn('[DeviceLink] Copy failed:', e);
        }
    };

    const tryStartLinking = () => {
        if (!vaultStore.showDeviceLinkModal) return;
        if (moduleState.linkingStarted) return;
        if (status.val !== 'init') return;

        moduleState.linkingStarted = true;
        setTimeout(() => {
            console.log('[DeviceLink] Triggering linking start');
            startLinking();
        }, 0);
    };

    const resetModalState = () => {
        cleanupTimers();
        status.val = 'init';
        linkToken.val = '';
        devicePublicIdState.val = '';
        expiresAt.val = null;
        timeRemaining.val = '';
        error.val = '';
        moduleState.linkingStarted = false;
        clearPendingDeviceId();
    };

    const ensureLinkingStarted = () => {
        if (!vaultStore.showDeviceLinkModal) return;
        if (status.val !== 'init') return;
        if (moduleState.linkingStarted) return;

        tryStartLinking();
    };

    const syncModalLifecycle = () => {
        if (!vaultStore.showDeviceLinkModal) {
            if (moduleState.lastModalVisible) {
                moduleState.lastModalVisible = false;
                resetModalState();
            }
            return;
        }

        if (!moduleState.lastModalVisible) {
            moduleState.lastModalVisible = true;
            resetModalState();
        }

        if (status.val === 'error' && !error.val) {
            error.val = 'An error occurred while setting up verification.';
        }

        ensureLinkingStarted();
    };

    return () => div({ class: 'device-link-modal-wrapper' },
        vaultStore.showDeviceLinkModal ? div({ class: 'modal-overlay' },
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
                    const currentDeviceId = devicePublicIdState.val;
                    const currentTimeRemaining = timeRemaining.val;
                    syncModalLifecycle();

                    return div({ class: 'modal-body' },
                        // Loading state
                        currentStatus === 'loading' ? div({ class: 'loading-state' },
                            p('Starting device verification...')
                        ) : null,

                        // Waiting for approval
                        currentStatus === 'waiting' ? div({ class: 'waiting-state' },
                            p({ class: 'description' },
                                'This device needs to be verified before you can access your encrypted messages. ' +
                                'Approve it from a device where you are already logged in.'
                            ),

                            currentToken ? div({ class: 'verification-code-wrap' },
                                p({ class: 'token-label' }, 'Pairing code'),
                                div({ class: 'verification-code' }, formatToken(currentToken)),
                                button({
                                    type: 'button',
                                    class: 'btn btn-sm btn-copy',
                                    onclick: copyToken,
                                    title: 'Copy code'
                                }, 'Copy'),
                                p({ class: 'verification-code-hint' }, 'Copy or tap the code, then paste it on the device that is being linked.')
                            ) : null,
                            currentDeviceId ? p({ class: 'device-id-display' }, `Device ID: ${currentDeviceId}`) : null,

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
                                    span('Tap "Device Link Requests" and approve the pending request.')
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

                        // Init state fallback (short while startLinking is called)
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
        ) : null
    );
}
