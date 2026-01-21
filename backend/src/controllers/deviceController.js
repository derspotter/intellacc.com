const db = require('../db');
const crypto = require('crypto');

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
