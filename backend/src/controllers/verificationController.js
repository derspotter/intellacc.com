/**
 * Verification Controller
 * Handles email, phone, and payment verification endpoints
 */
const db = require('../db');
const emailVerificationService = require('../services/emailVerificationService');
const phoneVerificationService = require('../services/phoneVerificationService');
const paymentVerificationService = require('../services/paymentVerificationService');

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

/**
 * Start phone verification (Tier 2)
 * POST /api/verification/phone/start
 */
exports.startPhoneVerification = async (req, res) => {
    try {
        const userId = req.user.id;
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number required' });
        }

        const result = await phoneVerificationService.startPhoneVerification(userId, phoneNumber);

        res.json({
            success: true,
            provider: result.provider,
            dev_code: result.devCode || undefined
        });
    } catch (err) {
        console.error('[VerificationController] Start phone error:', err);
        res.status(400).json({ error: err.message || 'Failed to start phone verification' });
    }
};

/**
 * Confirm phone verification (Tier 2)
 * POST /api/verification/phone/confirm
 */
exports.confirmPhoneVerification = async (req, res) => {
    try {
        const userId = req.user.id;
        const { phoneNumber, code } = req.body;

        if (!phoneNumber || !code) {
            return res.status(400).json({ error: 'Phone number and code required' });
        }

        await phoneVerificationService.confirmPhoneVerification(userId, phoneNumber, code);

        res.json({
            success: true,
            message: 'Phone verified successfully'
        });
    } catch (err) {
        console.error('[VerificationController] Confirm phone error:', err);
        res.status(400).json({ error: err.message || 'Phone verification failed' });
    }
};

/**
 * Create payment verification session (Tier 3)
 * POST /api/verification/payment/setup
 */
exports.createPaymentSetup = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await paymentVerificationService.createVerificationSession(userId);

        res.json({
            clientSecret: result.clientSecret,
            publishableKey: result.publishableKey
        });
    } catch (err) {
        console.error('[VerificationController] Payment setup error:', err);
        res.status(400).json({ error: err.message || 'Failed to create payment verification' });
    }
};

/**
 * Stripe webhook handler
 * POST /api/webhooks/stripe
 */
exports.handleStripeWebhook = async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const signature = req.headers['stripe-signature'];
    const noHandlerMessage = 'Webhook event received but ignored';

    let event = req.body;

    try {
        if (webhookSecret) {
            if (!signature) {
                return res.status(400).json({ error: 'Stripe signature missing' });
            }
            event = paymentVerificationService.constructWebhookEvent(req.rawBody, signature, webhookSecret);
        } else if (process.env.NODE_ENV === 'production') {
            return res.status(400).json({ error: 'Stripe webhook secret not configured' });
        }

        if (!event || typeof event !== 'object' || !event.type) {
            return res.status(400).json({ error: 'Invalid Stripe webhook payload' });
        }

        if (event.type === 'setup_intent.succeeded') {
            const setupIntent = event.data?.object;
            if (!setupIntent || typeof setupIntent !== 'object') {
                return res.status(400).json({ error: 'Invalid setup_intent payload' });
            }

            const result = await paymentVerificationService.handleSetupIntentSucceeded(setupIntent, event.id);

            return res.json({
                received: true,
                status: result.status,
                already_verified: result.alreadyVerified || false
            });
        }

        console.log('[VerificationController] Unhandled Stripe webhook event:', event.type);
        res.json({
            received: true,
            ignored: true,
            message: noHandlerMessage,
            event_type: event.type
        });
    } catch (err) {
        console.error('[VerificationController] Stripe webhook error:', err);
        res.status(400).json({ error: err.message || 'Webhook error' });
    }
};
