/**
 * Email Verification Component
 * Handles sending and resending verification emails
 */
import van from 'vanjs-core';
import api from '../../services/api.js';

const { div, h3, p, span, button, strong } = van.tags;

/**
 * EmailVerification component
 * @param {Object} props
 * @param {Function} props.onSuccess - Callback when verification succeeds
 * @param {string} props.userEmail - User's email address
 */
export default function EmailVerification({ onSuccess, userEmail } = {}) {
    const status = van.state('idle'); // 'idle' | 'sending' | 'sent' | 'error'
    const error = van.state('');
    const cooldown = van.state(0);

    // Cooldown timer
    let cooldownInterval = null;
    const startCooldown = (seconds) => {
        cooldown.val = seconds;
        if (cooldownInterval) clearInterval(cooldownInterval);
        cooldownInterval = setInterval(() => {
            cooldown.val = Math.max(0, cooldown.val - 1);
            if (cooldown.val === 0) {
                clearInterval(cooldownInterval);
                cooldownInterval = null;
            }
        }, 1000);
    };

    // Send verification email
    const sendVerification = async () => {
        if (cooldown.val > 0) return;

        status.val = 'sending';
        error.val = '';

        try {
            await api.verification.sendEmailVerification();
            status.val = 'sent';
            startCooldown(60); // 60 second cooldown between resends
        } catch (err) {
            console.error('[EmailVerification] Send error:', err);
            status.val = 'error';
            error.val = err.data?.error || err.message || 'Failed to send verification email';

            // If rate limited, extract retry time
            if (err.status === 429) {
                const retryAfter = err.data?.retryAfter || 60;
                startCooldown(retryAfter);
            }
        }
    };

    return div({ class: 'email-verification' },
        div({ class: 'verification-icon' }, '📧'),
        h3('Verify Your Email'),

        () => {
            const currentStatus = status.val;

            if (currentStatus === 'sent') {
                return div({ class: 'success-state' },
                    div({ class: 'success-icon' }, '✓'),
                    p({ class: 'success-message' },
                        'Verification email sent to ',
                        strong(userEmail || 'your email address'),
                        '.'
                    ),
                    p({ class: 'instructions' },
                        'Check your inbox and click the verification link. ',
                        'The link expires in 24 hours.'
                    ),
                    p({ class: 'spam-note' },
                        'Didn\'t receive it? Check your spam folder or ',
                        cooldown.val > 0
                            ? span({ class: 'cooldown' }, `wait ${cooldown.val}s to resend`)
                            : button({
                                type: 'button',
                                class: 'btn-link',
                                onclick: sendVerification
                            }, 'resend')
                    )
                );
            }

            if (currentStatus === 'sending') {
                return div({ class: 'loading-state' },
                    div({ class: 'spinner' }),
                    p('Sending verification email...')
                );
            }

            if (currentStatus === 'error') {
                return div({ class: 'error-state' },
                    p({ class: 'error-message' }, error.val),
                    button({
                        type: 'button',
                        class: 'btn btn-primary',
                        onclick: sendVerification,
                        disabled: cooldown.val > 0
                    }, cooldown.val > 0 ? `Wait ${cooldown.val}s` : 'Try Again')
                );
            }

            // Idle state
            return div({ class: 'idle-state' },
                p({ class: 'description' },
                    'Verify your email address to unlock posting, commenting, and messaging features.'
                ),
                userEmail ? p({ class: 'email-display' },
                    'We\'ll send a verification link to: ',
                    strong(userEmail)
                ) : null,
                button({
                    type: 'button',
                    class: 'btn btn-primary',
                    onclick: sendVerification
                }, 'Send Verification Email')
            );
        }
    );
}
