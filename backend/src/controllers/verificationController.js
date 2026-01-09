/**
 * Verification Controller
 * Handles email, phone, and payment verification endpoints
 */
const db = require('../db');
const emailVerificationService = require('../services/emailVerificationService');

/**
 * Send verification email
 * POST /api/auth/verify-email/send
 */
exports.sendVerificationEmail = async (req, res) => {
    try {
        const userId = req.user.id;

        // Fetch user's email from database
        const userResult = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const email = userResult.rows[0].email;

        // Check if already verified
        const status = await emailVerificationService.getVerificationStatus(userId);
        if (status.email_verified) {
            return res.status(400).json({ error: 'Email already verified' });
        }

        const result = await emailVerificationService.sendVerificationEmail(userId, email);

        res.json({
            success: true,
            message: 'Verification email sent. Please check your inbox.'
        });
    } catch (err) {
        console.error('[VerificationController] Send email error:', err);
        res.status(500).json({ error: 'Failed to send verification email' });
    }
};

/**
 * Confirm email verification
 * POST /api/auth/verify-email/confirm
 */
exports.confirmEmailVerification = async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }

        const result = await emailVerificationService.verifyEmailToken(token);

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            success: true,
            message: 'Email verified successfully! You can now post and message.',
            userId: result.userId
        });
    } catch (err) {
        console.error('[VerificationController] Confirm email error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
};

/**
 * Get current verification status
 * GET /api/verification/status
 */
exports.getVerificationStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const status = await emailVerificationService.getVerificationStatus(userId);

        // Add tier names for frontend display
        const tierNames = ['none', 'email', 'phone', 'payment'];
        const tierUnlocks = {
            0: ['Read content', 'Create account'],
            1: ['Post', 'Comment', 'Send messages'],
            2: ['Prediction markets'],
            3: ['Create markets', 'Governance voting']
        };

        res.json({
            current_tier: status.tier,
            current_tier_name: tierNames[status.tier],
            email_verified: status.email_verified,
            phone_verified: status.phone_verified,
            payment_verified: status.payment_verified,
            unlocks: tierUnlocks[status.tier] || [],
            next_tier: status.tier < 3 ? {
                tier: status.tier + 1,
                name: tierNames[status.tier + 1],
                unlocks: tierUnlocks[status.tier + 1] || []
            } : null
        });
    } catch (err) {
        console.error('[VerificationController] Get status error:', err);
        res.status(500).json({ error: 'Failed to get verification status' });
    }
};

/**
 * Resend verification email (rate limited)
 * POST /api/verification/email/resend
 */
exports.resendVerificationEmail = async (req, res) => {
    try {
        const userId = req.user.id;

        // Fetch user's email from database
        const userResult = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const email = userResult.rows[0].email;

        // Check if already verified
        const status = await emailVerificationService.getVerificationStatus(userId);
        if (status.email_verified) {
            return res.status(400).json({ error: 'Email already verified' });
        }

        const result = await emailVerificationService.sendVerificationEmail(userId, email);

        res.json({
            success: true,
            message: 'Verification email resent. Please check your inbox.'
        });
    } catch (err) {
        console.error('[VerificationController] Resend email error:', err);
        res.status(500).json({ error: 'Failed to resend verification email' });
    }
};
