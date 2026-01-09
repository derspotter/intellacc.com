/**
 * Email Verification Service
 * Handles sending verification emails and confirming tokens
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../db');

// Configuration from environment
const EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || 'dev-email-secret-change-in-production';
const EMAIL_TOKEN_EXPIRY = '24h';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Email transporter - configure based on environment
let transporter;

const initTransporter = () => {
    if (transporter) return transporter;

    // Use environment variables for SMTP config
    // In dev, you can use Ethereal (ethereal.email) for testing
    if (process.env.SMTP_HOST) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    } else {
        // Development fallback - log to console instead of sending
        console.log('[EmailVerification] No SMTP config, using console transport');
        transporter = {
            sendMail: async (options) => {
                console.log('[EmailVerification] Would send email:');
                console.log('  To:', options.to);
                console.log('  Subject:', options.subject);
                console.log('  URL:', options.html?.match(/href="([^"]+)"/)?.[1] || 'N/A');
                return { messageId: 'console-' + Date.now() };
            }
        };
    }

    return transporter;
};

/**
 * Generate a verification token for a user
 */
const generateToken = (userId, email) => {
    return jwt.sign(
        { userId, email, purpose: 'email_verify' },
        EMAIL_TOKEN_SECRET,
        { expiresIn: EMAIL_TOKEN_EXPIRY }
    );
};

/**
 * Hash a token for storage (we don't store raw tokens)
 */
const hashToken = (token) => {
    return crypto.createHash('sha256').update(token).digest('hex');
};

/**
 * Send a verification email to a user
 * @param {number} userId - User ID
 * @param {string} email - Email address
 * @returns {Promise<{success: boolean, messageId?: string}>}
 */
exports.sendVerificationEmail = async (userId, email) => {
    const transport = initTransporter();

    // Generate token
    const token = generateToken(userId, email);
    const tokenHash = hashToken(token);

    // Calculate expiry (24 hours from now)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Store token hash in database (invalidate any previous unused tokens)
    // First, delete any unused tokens for this user
    await db.query(`
        DELETE FROM email_verification_tokens
        WHERE user_id = $1 AND used_at IS NULL
    `, [userId]);

    // Then insert the new token
    await db.query(`
        INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
    `, [userId, tokenHash, expiresAt]);

    // Build verification URL - use POST-based flow to avoid token in referrers
    const verifyUrl = `${FRONTEND_URL}/#verify-email?token=${token}`;

    // Send email
    const result = await transport.sendMail({
        from: `"Intellacc" <${process.env.SMTP_FROM || 'noreply@intellacc.com'}>`,
        to: email,
        subject: 'Verify your Intellacc account',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { text-align: center; margin-bottom: 30px; }
                    .header h1 { color: #007bff; margin: 0; }
                    .button { display: inline-block; background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; }
                    .button:hover { background: #0056b3; }
                    .footer { margin-top: 30px; font-size: 12px; color: #666; text-align: center; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>Intellacc</h1>
                    </div>
                    <h2>Verify your email address</h2>
                    <p>Thanks for signing up! Click the button below to verify your email and unlock full access to Intellacc.</p>
                    <p style="text-align: center; margin: 30px 0;">
                        <a href="${verifyUrl}" class="button">Verify Email</a>
                    </p>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 12px;">
                        ${verifyUrl}
                    </p>
                    <p>This link expires in 24 hours.</p>
                    <div class="footer">
                        <p>If you didn't create an account on Intellacc, you can safely ignore this email.</p>
                        <p>&copy; ${new Date().getFullYear()} Intellacc</p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `
Welcome to Intellacc!

Verify your email by visiting this link:
${verifyUrl}

This link expires in 24 hours.

If you didn't create an account on Intellacc, you can safely ignore this email.
        `.trim()
    });

    console.log(`[EmailVerification] Sent verification email to ${email}, messageId: ${result.messageId}`);

    return { success: true, messageId: result.messageId };
};

/**
 * Verify an email token and upgrade user to Tier 1
 * @param {string} token - JWT verification token
 * @returns {Promise<{success: boolean, userId?: number, error?: string}>}
 */
exports.verifyEmailToken = async (token) => {
    try {
        // Verify JWT signature and expiry
        const decoded = jwt.verify(token, EMAIL_TOKEN_SECRET);

        if (decoded.purpose !== 'email_verify') {
            return { success: false, error: 'Invalid token purpose' };
        }

        const { userId, email } = decoded;
        const tokenHash = hashToken(token);

        // Check token exists and hasn't been used
        const tokenResult = await db.query(`
            SELECT id, used_at, expires_at
            FROM email_verification_tokens
            WHERE user_id = $1 AND token_hash = $2
        `, [userId, tokenHash]);

        if (tokenResult.rows.length === 0) {
            return { success: false, error: 'Token not found or already replaced' };
        }

        const tokenRecord = tokenResult.rows[0];

        if (tokenRecord.used_at) {
            return { success: false, error: 'Token already used' };
        }

        if (new Date(tokenRecord.expires_at) < new Date()) {
            return { success: false, error: 'Token expired' };
        }

        // Verify user email matches
        const userResult = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return { success: false, error: 'User not found' };
        }

        if (userResult.rows[0].email !== email) {
            return { success: false, error: 'Email mismatch' };
        }

        // Mark token as used
        await db.query(`
            UPDATE email_verification_tokens
            SET used_at = NOW()
            WHERE id = $1
        `, [tokenRecord.id]);

        // Create verification record (Tier 1)
        await db.query(`
            INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, verified_at)
            VALUES ($1, 1, 'email', 'internal', 'verified', NOW())
            ON CONFLICT (user_id, tier) DO UPDATE SET
                status = 'verified',
                verified_at = NOW(),
                updated_at = NOW()
        `, [userId]);

        // Update user's verification tier
        await db.query(`
            UPDATE users
            SET verification_tier = GREATEST(verification_tier, 1),
                email_verified_at = NOW()
            WHERE id = $1
        `, [userId]);

        console.log(`[EmailVerification] User ${userId} verified email successfully`);

        return { success: true, userId };
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return { success: false, error: 'Token expired' };
        }
        if (err.name === 'JsonWebTokenError') {
            return { success: false, error: 'Invalid token' };
        }
        console.error('[EmailVerification] Error verifying token:', err);
        return { success: false, error: 'Verification failed' };
    }
};

/**
 * Check if a user's email is verified
 * @param {number} userId - User ID
 * @returns {Promise<boolean>}
 */
exports.isEmailVerified = async (userId) => {
    const result = await db.query(`
        SELECT verification_tier, email_verified_at
        FROM users
        WHERE id = $1
    `, [userId]);

    if (result.rows.length === 0) return false;

    return result.rows[0].verification_tier >= 1 || result.rows[0].email_verified_at !== null;
};

/**
 * Get user's verification status
 * @param {number} userId - User ID
 * @returns {Promise<{tier: number, email_verified: boolean, phone_verified: boolean, payment_verified: boolean}>}
 */
exports.getVerificationStatus = async (userId) => {
    const result = await db.query(`
        SELECT
            u.verification_tier,
            u.email_verified_at,
            (SELECT COUNT(*) FROM user_verifications WHERE user_id = $1 AND tier = 1 AND status = 'verified') as email_verified,
            (SELECT COUNT(*) FROM user_verifications WHERE user_id = $1 AND tier = 2 AND status = 'verified') as phone_verified,
            (SELECT COUNT(*) FROM user_verifications WHERE user_id = $1 AND tier = 3 AND status = 'verified') as payment_verified
        FROM users u
        WHERE u.id = $1
    `, [userId]);

    if (result.rows.length === 0) {
        return { tier: 0, email_verified: false, phone_verified: false, payment_verified: false };
    }

    const row = result.rows[0];
    return {
        tier: row.verification_tier || 0,
        email_verified: parseInt(row.email_verified) > 0,
        phone_verified: parseInt(row.phone_verified) > 0,
        payment_verified: parseInt(row.payment_verified) > 0
    };
};
