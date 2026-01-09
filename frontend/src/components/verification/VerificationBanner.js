/**
 * Verification Banner Component
 * Shows a banner prompting users to verify their email
 */
import van from 'vanjs-core';
import api from '../../services/api.js';

const { div, p, span, button, a, strong } = van.tags;

// Module-level state to track banner dismissal for this session
let bannerDismissed = false;

/**
 * VerificationBanner component
 * Displays when user is logged in but not email verified
 */
export default function VerificationBanner() {
    const loading = van.state(true);
    const verificationTier = van.state(null);
    const dismissed = van.state(bannerDismissed);
    const sending = van.state(false);
    const sent = van.state(false);

    // Check verification status
    const checkStatus = async () => {
        try {
            const result = await api.verification.getStatus();
            verificationTier.val = result.current_tier;
        } catch (err) {
            // If error (like not logged in), don't show banner
            verificationTier.val = null;
        } finally {
            loading.val = false;
        }
    };

    // Send verification email
    const sendVerification = async () => {
        sending.val = true;
        try {
            await api.verification.sendEmailVerification();
            sent.val = true;
        } catch (err) {
            console.error('[VerificationBanner] Send error:', err);
            // Show error via notification if available
            if (window.showNotification) {
                window.showNotification(err.data?.error || 'Failed to send verification email', 'error');
            }
        } finally {
            sending.val = false;
        }
    };

    // Dismiss banner for this session
    const dismiss = () => {
        bannerDismissed = true;
        dismissed.val = true;
    };

    // Initial check
    checkStatus();

    return () => {
        // Don't show if:
        // - Still loading
        // - Already verified (tier >= 1)
        // - Banner dismissed
        // - Not logged in (tier is null)
        if (loading.val || dismissed.val || verificationTier.val === null || verificationTier.val >= 1) {
            return null;
        }

        return div({ class: 'verification-banner' },
            div({ class: 'banner-content' },
                span({ class: 'banner-icon' }, '📧'),
                () => {
                    if (sent.val) {
                        return div({ class: 'banner-text' },
                            strong('Verification email sent! '),
                            'Check your inbox and click the link to verify.'
                        );
                    }

                    return div({ class: 'banner-text' },
                        strong('Verify your email '),
                        'to unlock posting, commenting, and messaging.'
                    );
                }
            ),
            div({ class: 'banner-actions' },
                () => {
                    if (sent.val) {
                        return a({
                            href: '#settings/verification',
                            class: 'btn btn-sm'
                        }, 'View Status');
                    }

                    return button({
                        type: 'button',
                        class: 'btn btn-primary btn-sm',
                        onclick: sendVerification,
                        disabled: sending.val
                    }, sending.val ? 'Sending...' : 'Verify Now');
                },
                button({
                    type: 'button',
                    class: 'btn-close',
                    onclick: dismiss,
                    title: 'Dismiss'
                }, '×')
            )
        );
    };
}
