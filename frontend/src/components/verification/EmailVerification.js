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

    return div({ class: 'email-verification', style: 'text-align: left; padding: 1rem 0;' },
        div({ class: 'verification-icon', style: 'font-size: 2rem; margin-bottom: 0.5rem;' }, '📧'),
        h3({ style: 'margin-top: 0; margin-bottom: 0.5rem;' }, 'Verify Your Email'),

        () => {
            const currentStatus = status.val;

            if (currentStatus === 'sent') {
                return div({ class: 'success-state', style: 'text-align: left; padding: 1rem 0;' },
                    div({ class: 'success-icon', style: 'display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: var(--success-color); color: white; border-radius: 50%; margin-bottom: 0.5rem;' }, '✓'),
                    p({ class: 'success-message', style: 'margin-bottom: 0.5rem;' },
                        'Verification email sent to ',
                        strong(userEmail || 'your email address'),
                        '.'
                    ),
                    p({ class: 'instructions', style: 'margin-bottom: 0.5rem;' },
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
                                style: 'padding: 0; margin: 0; border: none; background: none; color: var(--primary-color); cursor: pointer; text-decoration: underline;',
                                onclick: sendVerification
                            }, 'resend')
                    )
                );
            }

            if (currentStatus === 'sending') {
                return div({ class: 'loading-state', style: 'text-align: left;' },
                    div({ class: 'spinner', style: 'margin-bottom: 0.5rem;' }),
                    p({ style: 'margin: 0;' }, 'Sending verification email...')
                );
            }

            if (currentStatus === 'error') {
                return div({ class: 'error-state', style: 'text-align: left;' },
                    p({ class: 'error-message', style: 'margin-bottom: 1rem;' }, error.val),
                    button({
                        type: 'button',
                        class: 'button button-primary',
                        onclick: sendVerification,
                        disabled: cooldown.val > 0
                    }, cooldown.val > 0 ? `Wait ${cooldown.val}s` : 'Try Again')
                );
            }

            // Idle state
            return div({ class: 'idle-state', style: 'text-align: left;' },
                p({ class: 'description', style: 'margin-bottom: 0.5rem;' },
                    'Verify your email address to unlock posting, commenting, and messaging features.'
                ),
                userEmail ? p({ class: 'email-display', style: 'margin-bottom: 1.5rem;' },
                    'We\'ll send a verification link to: ',
                    strong(userEmail)
                ) : null,
                button({
                    type: 'button',
                    class: 'button button-primary',
                    onclick: sendVerification
                }, 'Send Verification Email')
            );
        }
    );
}
