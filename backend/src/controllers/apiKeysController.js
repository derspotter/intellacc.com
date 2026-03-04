const db = require('../db');
const crypto = require('crypto');

const generateApiKey = () => {
    return 'sk_live_' + crypto.randomBytes(32).toString('hex');
};

const hashApiKey = (key) => {
    return crypto.createHash('sha256').update(key).digest('hex');
};

/**
 * Create a new API key for the authenticated user
 */
const createKey = async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, isBot } = req.body;

        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'API key name is required' });
        }

        const isBotBool = Boolean(isBot);

        // Limit the number of keys per user (e.g., max 5)
        const countResult = await db.query('SELECT COUNT(*) FROM api_keys WHERE user_id = $1', [userId]);
        if (parseInt(countResult.rows[0].count) >= 5) {
            return res.status(400).json({ error: 'Maximum number of API keys reached (5)' });
        }

        const plainKey = generateApiKey();
        const hashedKey = hashApiKey(plainKey);

        const insertResult = await db.query(
            'INSERT INTO api_keys (user_id, name, key_hash, is_bot) VALUES ($1, $2, $3, $4) RETURNING id, name, is_bot, created_at',
            [userId, name.trim(), hashedKey, isBotBool]
        );

        res.status(201).json({
            message: 'API key created successfully. Please copy it now as it will not be shown again.',
            apiKey: plainKey,
            keyDetails: insertResult.rows[0]
        });

    } catch (err) {
        console.error('Error creating API key:', err);
        res.status(500).json({ error: 'Failed to create API key' });
    }
};

/**
 * List all API keys for the authenticated user (without revealing the full keys)
 */
const listKeys = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await db.query(
            'SELECT id, name, is_bot, created_at, last_used_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        res.json({ keys: result.rows });
    } catch (err) {
        console.error('Error listing API keys:', err);
        res.status(500).json({ error: 'Failed to list API keys' });
    }
};

/**
 * Revoke an API key
 */
const revokeKey = async (req, res) => {
    try {
        const userId = req.user.id;
        const keyId = req.params.id;

        const result = await db.query(
            'DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id',
            [keyId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'API key not found' });
        }

        res.json({ message: 'API key revoked successfully' });
    } catch (err) {
        console.error('Error revoking API key:', err);
        res.status(500).json({ error: 'Failed to revoke API key' });
    }
};

module.exports = {
    createKey,
    listKeys,
    revokeKey,
    hashApiKey // exported for use in middleware
};
