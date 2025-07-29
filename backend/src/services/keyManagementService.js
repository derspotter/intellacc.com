// backend/src/services/keyManagementService.js
const db = require('../db');
const crypto = require('crypto');

/**
 * Generate a SHA-256 fingerprint for a public key
 * @param {string} publicKey - Base64 encoded public key
 * @returns {string} Hex encoded fingerprint
 */
function generateKeyFingerprint(publicKey) {
  return crypto.createHash('sha256').update(publicKey).digest('hex');
}

/**
 * Store a user's public key
 * @param {number} userId - User ID
 * @param {string} publicKey - Base64 encoded RSA public key
 * @returns {Promise<Object>} Stored key record
 */
async function storeUserPublicKey(userId, publicKey) {
  try {
    const fingerprint = generateKeyFingerprint(publicKey);
    
    const result = await db.query(
      `INSERT INTO user_keys (user_id, public_key, key_fingerprint)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         public_key = EXCLUDED.public_key,
         key_fingerprint = EXCLUDED.key_fingerprint,
         updated_at = NOW()
       RETURNING *`,
      [userId, publicKey, fingerprint]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Error storing user public key:', error);
    throw error;
  }
}

/**
 * Get a user's public key
 * @param {number} userId - User ID
 * @returns {Promise<Object|null>} User's key record or null if not found
 */
async function getUserPublicKey(userId) {
  try {
    const result = await db.query(
      'SELECT * FROM user_keys WHERE user_id = $1',
      [userId]
    );

    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting user public key:', error);
    throw error;
  }
}

/**
 * Get public keys for multiple users
 * @param {number[]} userIds - Array of user IDs
 * @returns {Promise<Object[]>} Array of user key records
 */
async function getMultipleUserPublicKeys(userIds) {
  try {
    if (!userIds || userIds.length === 0) {
      return [];
    }

    const result = await db.query(
      `SELECT uk.*, u.username 
       FROM user_keys uk
       JOIN users u ON uk.user_id = u.id
       WHERE uk.user_id = ANY($1::int[])`,
      [userIds]
    );

    return result.rows;
  } catch (error) {
    console.error('Error getting multiple user public keys:', error);
    throw error;
  }
}

/**
 * Check if a user has a public key stored
 * @param {number} userId - User ID
 * @returns {Promise<boolean>} True if user has a key
 */
async function userHasPublicKey(userId) {
  try {
    const result = await db.query(
      'SELECT 1 FROM user_keys WHERE user_id = $1',
      [userId]
    );

    return result.rows.length > 0;
  } catch (error) {
    console.error('Error checking if user has public key:', error);
    throw error;
  }
}

/**
 * Get all users who have public keys (for user discovery)
 * @param {number} excludeUserId - User ID to exclude from results
 * @param {number} limit - Maximum number of results
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Object[]>} Array of users with keys
 */
async function getUsersWithKeys(excludeUserId = null, limit = 50, offset = 0) {
  try {
    let query = `
      SELECT u.id, u.username, uk.key_fingerprint, uk.created_at
      FROM users u
      JOIN user_keys uk ON u.id = uk.user_id
    `;
    
    const params = [];
    
    if (excludeUserId) {
      query += ' WHERE u.id != $1';
      params.push(excludeUserId);
      query += ' ORDER BY u.username LIMIT $2 OFFSET $3';
      params.push(limit, offset);
    } else {
      query += ' ORDER BY u.username LIMIT $1 OFFSET $2';
      params.push(limit, offset);
    }

    const result = await db.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('Error getting users with keys:', error);
    throw error;
  }
}

/**
 * Delete a user's public key
 * @param {number} userId - User ID
 * @returns {Promise<boolean>} True if key was deleted
 */
async function deleteUserPublicKey(userId) {
  try {
    const result = await db.query(
      'DELETE FROM user_keys WHERE user_id = $1',
      [userId]
    );

    return result.rowCount > 0;
  } catch (error) {
    console.error('Error deleting user public key:', error);
    throw error;
  }
}

/**
 * Verify key fingerprint matches stored key
 * @param {number} userId - User ID  
 * @param {string} providedFingerprint - Fingerprint to verify
 * @returns {Promise<boolean>} True if fingerprint matches
 */
async function verifyKeyFingerprint(userId, providedFingerprint) {
  try {
    const result = await db.query(
      'SELECT key_fingerprint FROM user_keys WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    return result.rows[0].key_fingerprint === providedFingerprint;
  } catch (error) {
    console.error('Error verifying key fingerprint:', error);
    throw error;
  }
}

/**
 * Get key statistics for monitoring
 * @returns {Promise<Object>} Key statistics
 */
async function getKeyStatistics() {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*) as total_keys,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as keys_created_last_week,
        COUNT(CASE WHEN updated_at > NOW() - INTERVAL '7 days' THEN 1 END) as keys_updated_last_week,
        MIN(created_at) as oldest_key,
        MAX(created_at) as newest_key
      FROM user_keys
    `);

    return result.rows[0];
  } catch (error) {
    console.error('Error getting key statistics:', error);
    throw error;
  }
}

module.exports = {
  storeUserPublicKey,
  getUserPublicKey,
  getMultipleUserPublicKeys,
  userHasPublicKey,
  getUsersWithKeys,
  deleteUserPublicKey,
  verifyKeyFingerprint,
  generateKeyFingerprint,
  getKeyStatistics
};