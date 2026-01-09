const db = require('../db');
const crypto = require('crypto');

// Use built-in crypto.randomUUID() for UUID generation
const uuidv4 = () => crypto.randomUUID();

// Helper to validate UUID format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isValidUUID = (str) => str && UUID_REGEX.test(str);

// ============================================================
// PRE-LOGIN DEVICE VERIFICATION (Unauthenticated endpoints)
// These endpoints support the staged login flow where device
// verification happens BEFORE the user enters their password.
// ============================================================

/**
 * Check if a device is verified for a given email (unauthenticated)
 * Always returns the same structure to prevent account enumeration
 */
exports.checkDeviceStatus = async (req, res) => {
    const { email, deviceFingerprint } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    try {
        // Generate session token for this login attempt
        const sessionToken = uuidv4();

        // Look up user by email
        const userResult = await db.query(
            'SELECT id FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        let requiresVerification = true;

        if (userResult.rows.length > 0) {
            const userId = userResult.rows[0].id;

            // Check if any devices exist for this user
            const deviceCountResult = await db.query(
                'SELECT count(*) FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL',
                [userId]
            );
            const hasDevices = parseInt(deviceCountResult.rows[0].count) > 0;

            if (!hasDevices) {
                // First device - no verification needed
                requiresVerification = false;
            } else if (deviceFingerprint && isValidUUID(deviceFingerprint)) {
                // Check if this specific device is verified (only if fingerprint is a valid UUID)
                const deviceResult = await db.query(
                    'SELECT id FROM user_devices WHERE user_id = $1 AND device_public_id = $2 AND revoked_at IS NULL',
                    [userId, deviceFingerprint]
                );
                if (deviceResult.rows.length > 0) {
                    requiresVerification = false;
                }
            }
        }
        // For non-existent users, requiresVerification stays true (anti-enumeration)

        // Add small random delay to prevent timing attacks (50-150ms)
        await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

        res.json({
            requiresVerification,
            sessionToken
        });
    } catch (e) {
        console.error('[checkDeviceStatus] Error:', e);
        res.status(500).json({ error: 'Failed to check device status' });
    }
};

/**
 * Start pre-login device linking (unauthenticated)
 * Generates verification code and notifies existing devices
 */
exports.startPreLoginLink = async (req, res) => {
    const { sessionToken, email, deviceFingerprint, deviceName } = req.body;

    if (!sessionToken || !email) {
        return res.status(400).json({ error: 'sessionToken and email required' });
    }

    // Validate sessionToken is a valid UUID to prevent DB errors
    if (!isValidUUID(sessionToken)) {
        return res.status(400).json({ error: 'Invalid sessionToken format' });
    }

    try {
        // Generate verification code (6 alphanumeric chars)
        const verificationCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        // Check if email exists (for real linking vs dummy)
        const userResult = await db.query(
            'SELECT id FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        // Store the request regardless of whether user exists
        // This prevents timing attacks
        await db.query(
            `INSERT INTO pre_login_link_requests
             (session_token, email, device_fingerprint, verification_code, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (session_token) DO UPDATE SET
             verification_code = $4, expires_at = $5, status = 'pending'`,
            [sessionToken, email.toLowerCase(), deviceFingerprint, verificationCode, expiresAt]
        );

        // If user exists, notify their existing devices (TODO: implement push notification)
        if (userResult.rows.length > 0) {
            // Note: Verification code intentionally NOT logged for security
            // Future: Send push notification to existing devices
        }

        res.json({
            verificationCode,
            expiresAt: expiresAt.toISOString()
        });
    } catch (e) {
        console.error('[startPreLoginLink] Error:', e);
        res.status(500).json({ error: 'Failed to start linking' });
    }
};

/**
 * Check pre-login link status (unauthenticated polling endpoint)
 */
exports.getPreLoginLinkStatus = async (req, res) => {
    const { sessionToken } = req.params;

    if (!sessionToken) {
        return res.status(400).json({ error: 'sessionToken required' });
    }

    // Validate sessionToken is a valid UUID to prevent DB errors
    if (!isValidUUID(sessionToken)) {
        return res.status(400).json({ error: 'Invalid sessionToken format' });
    }

    try {
        const result = await db.query(
            'SELECT status, device_public_id, expires_at FROM pre_login_link_requests WHERE session_token = $1',
            [sessionToken]
        );

        if (result.rows.length === 0) {
            return res.json({ status: 'not_found' });
        }

        const request = result.rows[0];

        // Check if expired
        if (new Date(request.expires_at) < new Date()) {
            // Update status to expired
            await db.query(
                'UPDATE pre_login_link_requests SET status = $1 WHERE session_token = $2',
                ['expired', sessionToken]
            );
            return res.json({ status: 'expired' });
        }

        res.json({
            status: request.status,
            devicePublicId: request.device_public_id
        });
    } catch (e) {
        console.error('[getPreLoginLinkStatus] Error:', e);
        res.status(500).json({ error: 'Failed to check link status' });
    }
};

/**
 * Approve pre-login link (authenticated - from existing device)
 */
exports.approvePreLoginLink = async (req, res) => {
    const userId = req.user.id;
    const { verificationCode, approvingDeviceId } = req.body;

    if (!verificationCode) {
        return res.status(400).json({ error: 'verificationCode required' });
    }

    try {
        // Verify the approving device is valid and not revoked (if device ID provided)
        if (approvingDeviceId) {
            const approvingDeviceResult = await db.query(
                'SELECT id FROM user_devices WHERE user_id = $1 AND device_public_id = $2 AND revoked_at IS NULL',
                [userId, approvingDeviceId]
            );
            if (approvingDeviceResult.rows.length === 0) {
                return res.status(403).json({ error: 'Approving device is not verified or has been revoked' });
            }
        }

        // Find the pending request by verification code and user's email
        const userResult = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const userEmail = userResult.rows[0].email;

        const requestResult = await db.query(
            `SELECT id, session_token, device_fingerprint
             FROM pre_login_link_requests
             WHERE email = $1 AND verification_code = $2 AND status = 'pending' AND expires_at > NOW()`,
            [userEmail, verificationCode.toUpperCase()]
        );

        if (requestResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        const request = requestResult.rows[0];

        // Generate device_public_id for the new device
        const devicePublicId = uuidv4();

        // Create the device record
        await db.query(
            `INSERT INTO user_devices (user_id, device_public_id, name, last_verified_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (device_public_id) DO UPDATE SET last_seen_at = NOW(), last_verified_at = NOW()`,
            [userId, devicePublicId, 'New Device']
        );

        // Update the request as approved
        await db.query(
            `UPDATE pre_login_link_requests
             SET status = 'approved', device_public_id = $1
             WHERE id = $2`,
            [devicePublicId, request.id]
        );

        console.log(`[approvePreLoginLink] Approved link for user ${userId}, device: ${devicePublicId}`);

        res.json({
            success: true,
            devicePublicId
        });
    } catch (e) {
        console.error('[approvePreLoginLink] Error:', e);
        res.status(500).json({ error: 'Failed to approve link' });
    }
};

// ============================================================
// AUTHENTICATED DEVICE MANAGEMENT
// ============================================================

exports.listDevices = async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await db.query(
            'SELECT id, device_public_id, name, is_primary, created_at, last_seen_at FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at ASC',
            [userId]
        );
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to list devices' });
    }
};

exports.revokeDevice = async (req, res) => {
    const userId = req.user.id;
    const deviceId = req.params.id;
    try {
        await db.query(
            'UPDATE user_devices SET revoked_at = NOW() WHERE id = $1 AND user_id = $2',
            [deviceId, userId]
        );
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to revoke device' });
    }
};

// Start linking process (for new device)
exports.startLinking = async (req, res) => {
    const userId = req.user.id;
    const { device_public_id, name } = req.body;

    if (!device_public_id) return res.status(400).json({ error: 'device_public_id required' });

    try {
        const token = crypto.randomBytes(32).toString('hex');
        const expires_at = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await db.query(
            'INSERT INTO device_linking_tokens (user_id, token, device_public_id, device_name, expires_at) VALUES ($1, $2, $3, $4, $5)',
            [userId, token, device_public_id, name || 'New Device', expires_at]
        );

        res.json({ token, expires_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to start linking' });
    }
};

// Approve linking (from trusted device)
exports.approveLinking = async (req, res) => {
    const userId = req.user.id;
    const { token, approving_device_id } = req.body;

    try {
        const tokenResult = await db.query(
            'SELECT * FROM device_linking_tokens WHERE token = $1 AND user_id = $2 AND expires_at > NOW() AND approved_at IS NULL',
            [token, userId]
        );

        if (tokenResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }

        const linkToken = tokenResult.rows[0];

        // 1. Mark token as approved
        await db.query(
            'UPDATE device_linking_tokens SET approved_at = NOW(), approved_by_device_id = $1 WHERE id = $2',
            [approving_device_id, linkToken.id]
        );

        // 2. Create or update the device record
        const deviceResult = await db.query(
            'INSERT INTO user_devices (user_id, device_public_id, name, last_verified_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (device_public_id) DO UPDATE SET last_seen_at = NOW(), last_verified_at = NOW() RETURNING *',
            [userId, linkToken.device_public_id, linkToken.device_name]
        );

        res.json({ success: true, device: deviceResult.rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to approve linking' });
    }
};

// Check linking status (polling for new device)
exports.checkLinkingStatus = async (req, res) => {
    const userId = req.user.id;
    const { token } = req.query;

    try {
        const result = await db.query(
            'SELECT approved_at FROM device_linking_tokens WHERE token = $1 AND user_id = $2',
            [token, userId]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Token not found' });
        
        res.json({ approved: !!result.rows[0].approved_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to check status' });
    }
};

exports.registerDevice = async (req, res) => {
    const userId = req.user.id;
    const { device_public_id, name } = req.body;

    if (!device_public_id) return res.status(400).json({ error: 'device_public_id required' });

    try {
        const device = await exports.registerInitialDevice(userId, device_public_id, name);
        res.json(device);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to register device' });
    }
};

// Internal helper for bootstrapping (first device)
exports.registerInitialDevice = async (userId, devicePublicId, name) => {
    // Check if any devices exist
    const countRes = await db.query('SELECT count(*) FROM user_devices WHERE user_id = $1', [userId]);
    const isFirst = parseInt(countRes.rows[0].count) === 0;

    const result = await db.query(
        'INSERT INTO user_devices (user_id, device_public_id, name, is_primary) VALUES ($1, $2, $3, $4) ON CONFLICT (device_public_id) DO UPDATE SET last_seen_at = NOW() RETURNING *',
        [userId, devicePublicId, name || 'Primary Device', isFirst]
    );
    return result.rows[0];
};
