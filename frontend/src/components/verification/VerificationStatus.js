/**
 * Verification Status Component
 * Displays current verification tier and available upgrades
 */
import van from 'vanjs-core';
import api from '../../services/api.js';

const { div, h3, p, span, button } = van.tags;

const TIER_INFO = [
    {
        level: 0,
        name: 'Unverified',
        icon: '👤',
        description: 'Read-only access',
        unlocks: ['Browse content', 'View predictions']
    },
    {
        level: 1,
        name: 'Email Verified',
        icon: '📧',
        description: 'Basic account features',
        unlocks: ['Create posts', 'Comment', 'Send messages']
    },
    {
        level: 2,
        name: 'Phone Verified',
        icon: '📱',
        description: 'Market participation',
        unlocks: ['Prediction markets', 'Trade shares']
    },
    {
        level: 3,
        name: 'Payment Verified',
        icon: '💳',
        description: 'Full platform access',
        unlocks: ['Create markets', 'Governance voting']
    }
];

/**
 * VerificationStatus component
 * @param {Object} props
 * @param {Function} props.onUpgrade - Callback when user clicks upgrade
 */
export default function VerificationStatus({ onUpgrade } = {}) {
    const loading = van.state(true);
    const error = van.state('');
    const status = van.state(null);

    // Fetch verification status
    const fetchStatus = async () => {
        loading.val = true;
        error.val = '';
        try {
            const result = await api.verification.getStatus();
            status.val = result;
        } catch (err) {
            console.error('[VerificationStatus] Error:', err);
            error.val = err.message || 'Failed to load verification status';
        } finally {
            loading.val = false;
        }
    };

    // Initial fetch
    fetchStatus();

    return div({ class: 'verification-status' },
        h3('Verification Status'),

        () => {
            if (loading.val) {
                return div({ class: 'loading' }, 'Loading verification status...');
            }

            if (error.val) {
                return div({ class: 'error-message' },
                    p(error.val),
                    button({
                        type: 'button',
                        class: 'btn btn-sm',
                        onclick: fetchStatus
                    }, 'Retry')
                );
            }

            const currentTier = status.val?.current_tier || 0;
            const capabilities = status.val?.provider_capabilities || {};
            const canUpgradeTo = (targetTier) => {
                if (targetTier === 2) {
                    return capabilities.phone?.enabled !== false;
                }
                if (targetTier === 3) {
                    return capabilities.payment?.enabled !== false;
                }
                return true;
            };

            return div({ class: 'tier-list' },
                TIER_INFO.map(tier =>
                    div({
                        class: `tier-item tier-level-${tier.level} ${currentTier >= tier.level ? 'verified' : ''} ${currentTier === tier.level ? 'current' : ''}`
                    },
                        div({ class: 'tier-header' },
                            span({ class: 'tier-icon' }, tier.icon),
                            span({ class: 'tier-name' }, `Tier ${tier.level}: ${tier.name}`),
                            currentTier >= tier.level
                                ? span({ class: 'tier-badge verified' }, '✓')
                                : span({ class: 'tier-badge pending' }, '○')
                        ),
                        div({ class: 'tier-details' },
                            p({ class: 'tier-description' }, tier.description),
                            div({ class: 'tier-unlocks' },
                                span({ class: 'unlocks-label' }, 'Unlocks: '),
                                span(tier.unlocks.join(', '))
                            )
                        ),
                        // Show upgrade button for next tier
                        currentTier === tier.level - 1 && onUpgrade && canUpgradeTo(tier.level)
                            ? button({
                                type: 'button',
                                class: 'btn btn-primary btn-sm upgrade-btn',
                                onclick: () => onUpgrade(tier.level)
                            }, `Verify ${tier.name.replace(' Verified', '')}`)
                            : null
                    )
                )
            );
        }
    );
}
