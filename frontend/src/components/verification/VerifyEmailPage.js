/**
 * Verify Email Page Component
 * Landing page for email verification links
 * URL: /#verify-email?token=...
 */
import van from 'vanjs-core';
import api from '../../services/api.js';

const { div, h1, h2, p, button, a } = van.tags;

/**
 * VerifyEmailPage component
 * Automatically verifies email when loaded with token
 */
export default function VerifyEmailPage() {
    const status = van.state('verifying'); // 'verifying' | 'success' | 'error'
    const error = van.state('');

    // Extract token from URL hash
    const getTokenFromHash = () => {
        const hash = window.location.hash;
        const match = hash.match(/[?&]token=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    };

    // Verify the email token
    const verifyEmail = async () => {
        const token = getTokenFromHash();

        if (!token) {
            status.val = 'error';
            error.val = 'No verification token found. Please use the link from your email.';
            return;
        }

        try {
            const result = await api.verification.confirmEmailVerification(token);
            status.val = 'success';
            console.log('[VerifyEmail] Success:', result);
        } catch (err) {
            console.error('[VerifyEmail] Error:', err);
            status.val = 'error';
            error.val = err.data?.error || err.message || 'Verification failed';
        }
    };

    // Start verification on mount
    verifyEmail();

    return div({ class: 'verify-email-page' },
        div({ class: 'verification-card' },
            () => {
                const currentStatus = status.val;

                if (currentStatus === 'verifying') {
                    return div({ class: 'verifying-state' },
                        div({ class: 'spinner large' }),
                        h2('Verifying your email...'),
                        p('Please wait while we confirm your email address.')
                    );
                }

                if (currentStatus === 'success') {
                    return div({ class: 'success-state' },
                        div({ class: 'success-icon large' }, '✓'),
                        h1('Email Verified!'),
                        p({ class: 'success-message' },
                            'Your email has been verified successfully. You can now post, comment, and send messages.'
                        ),
                        div({ class: 'actions' },
                            a({
                                href: '#home',
                                class: 'btn btn-primary'
                            }, 'Go to Home'),
                            a({
                                href: '#settings',
                                class: 'btn btn-secondary'
                            }, 'View Settings')
                        )
                    );
                }

                // Error state
                return div({ class: 'error-state' },
                    div({ class: 'error-icon large' }, '✗'),
                    h1('Verification Failed'),
                    p({ class: 'error-message' }, error.val),
                    div({ class: 'error-help' },
                        p('This can happen if:'),
                        div({ class: 'error-reasons' },
                            p('• The link has expired (links are valid for 24 hours)'),
                            p('• The link was already used'),
                            p('• The link was copied incorrectly')
                        )
                    ),
                    div({ class: 'actions' },
                        a({
                            href: '#settings/verification',
                            class: 'btn btn-primary'
                        }, 'Request New Link'),
                        a({
                            href: '#home',
                            class: 'btn btn-secondary'
                        }, 'Go to Home')
                    )
                );
            }
        )
    );
}
