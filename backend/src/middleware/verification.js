/**
 * Verification Middleware
 * Gates routes based on user's verification tier
 */
const db = require('../db');

const TIER_NAMES = ['none', 'email', 'phone', 'payment'];
const TIER_REQUIREMENTS = {
    1: 'Verify your email to unlock this feature',
    2: 'Verify your phone number to unlock this feature',
    3: 'Add a payment method to unlock this feature'
};

/**
 * Middleware factory that requires a minimum verification tier
 * @param {number} minTier - Minimum required tier (1-3)
 * @returns {Function} Express middleware
 */
const requireTier = (minTier) => {
    return async (req, res, next) => {
        // Must be authenticated first
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Get current user's verification tier
        const userId = req.user.id;

        // Use cached tier from req.user if available, otherwise query DB
        let verificationTier = req.user.verification_tier;

        if (verificationTier === undefined || verificationTier === null) {
            try {
                const result = await db.query(
                    'SELECT verification_tier FROM users WHERE id = $1',
                    [userId]
                );

                if (result.rows.length === 0) {
                    return res.status(401).json({ error: 'User not found' });
                }

                verificationTier = result.rows[0].verification_tier || 0;

                // Cache on request for subsequent checks
                req.user.verification_tier = verificationTier;
            } catch (err) {
                console.error('[VerificationMiddleware] Error fetching tier:', err);
                return res.status(500).json({ error: 'Failed to verify user tier' });
            }
        }

        // Check if user meets minimum tier
        if (verificationTier < minTier) {
            return res.status(403).json({
                error: 'Higher verification required',
                message: TIER_REQUIREMENTS[minTier] || 'Additional verification required',
                required_tier: minTier,
                required_tier_name: TIER_NAMES[minTier],
                current_tier: verificationTier,
                current_tier_name: TIER_NAMES[verificationTier],
                upgrade_url: '/#settings/verification'
            });
        }

        next();
    };
};

/**
 * Middleware that requires email verification (Tier 1)
 */
const requireEmailVerified = requireTier(1);

/**
 * Middleware that requires phone verification (Tier 2)
 */
const requirePhoneVerified = requireTier(2);

/**
 * Middleware that requires payment verification (Tier 3)
 */
const requirePaymentVerified = requireTier(3);

/**
 * Soft verification check - adds verification info to request but doesn't block
 * Useful for endpoints that show different content based on tier
 */
const checkVerificationTier = async (req, res, next) => {
    if (!req.user) {
        req.verificationTier = 0;
        return next();
    }

    try {
        const result = await db.query(
            'SELECT verification_tier FROM users WHERE id = $1',
            [req.user.id]
        );

        req.verificationTier = result.rows[0]?.verification_tier || 0;
        req.user.verification_tier = req.verificationTier;
    } catch (err) {
        console.error('[VerificationMiddleware] Error in soft check:', err);
        req.verificationTier = 0;
    }

    next();
};

module.exports = {
    requireTier,
    requireEmailVerified,
    requirePhoneVerified,
    requirePaymentVerified,
    checkVerificationTier,
    TIER_NAMES,
    TIER_REQUIREMENTS
};
