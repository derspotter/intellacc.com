// backend/src/controllers/keyManagementController.js
const keyManagementService = require('../services/keyManagementService');

/**
 * Store user's public key
 * POST /api/keys
 */
async function storePublicKey(req, res) {
  try {
    const { publicKey } = req.body;
    const userId = req.user.id;

    if (!publicKey) {
      return res.status(400).json({ 
        error: 'Public key is required' 
      });
    }

    // Basic validation - check if it looks like a base64 encoded key
    if (typeof publicKey !== 'string' || publicKey.length < 100) {
      return res.status(400).json({ 
        error: 'Invalid public key format' 
      });
    }

    const keyRecord = await keyManagementService.storeUserPublicKey(userId, publicKey);
    
    res.json({
      success: true,
      key: {
        userId: keyRecord.user_id,
        fingerprint: keyRecord.key_fingerprint,
        createdAt: keyRecord.created_at,
        updatedAt: keyRecord.updated_at
      }
    });
  } catch (error) {
    console.error('Error storing public key:', error);
    res.status(500).json({ 
      error: 'Failed to store public key' 
    });
  }
}

/**
 * Get user's own public key
 * GET /api/keys/me
 */
async function getMyPublicKey(req, res) {
  try {
    const userId = req.user.id;
    
    const keyRecord = await keyManagementService.getUserPublicKey(userId);
    
    if (!keyRecord) {
      return res.status(404).json({ 
        error: 'No public key found for user' 
      });
    }

    res.json({
      key: {
        userId: keyRecord.user_id,
        publicKey: keyRecord.public_key,
        fingerprint: keyRecord.key_fingerprint,
        createdAt: keyRecord.created_at,
        updatedAt: keyRecord.updated_at
      }
    });
  } catch (error) {
    console.error('Error getting own public key:', error);
    res.status(500).json({ 
      error: 'Failed to get public key' 
    });
  }
}

/**
 * Get another user's public key
 * GET /api/keys/user/:userId
 */
async function getUserPublicKey(req, res) {
  try {
    const { userId } = req.params;
    
    if (!userId || isNaN(parseInt(userId))) {
      return res.status(400).json({ 
        error: 'Invalid user ID' 
      });
    }

    const keyRecord = await keyManagementService.getUserPublicKey(parseInt(userId));
    
    if (!keyRecord) {
      return res.status(404).json({ 
        error: 'No public key found for user' 
      });
    }

    // Don't return the full key record, only what's needed for encryption
    res.json({
      key: {
        userId: keyRecord.user_id,
        publicKey: keyRecord.public_key,
        fingerprint: keyRecord.key_fingerprint
      }
    });
  } catch (error) {
    console.error('Error getting user public key:', error);
    res.status(500).json({ 
      error: 'Failed to get public key' 
    });
  }
}

/**
 * Get public keys for multiple users
 * POST /api/keys/batch
 */
async function getMultiplePublicKeys(req, res) {
  try {
    const { userIds } = req.body;
    
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ 
        error: 'userIds must be a non-empty array' 
      });
    }

    // Validate all userIds are numbers
    const validUserIds = userIds.filter(id => !isNaN(parseInt(id))).map(id => parseInt(id));
    
    if (validUserIds.length === 0) {
      return res.status(400).json({ 
        error: 'No valid user IDs provided' 
      });
    }

    const keyRecords = await keyManagementService.getMultipleUserPublicKeys(validUserIds);
    
    const keys = keyRecords.map(record => ({
      userId: record.user_id,
      username: record.username,
      publicKey: record.public_key,
      fingerprint: record.key_fingerprint
    }));

    res.json({ keys });
  } catch (error) {
    console.error('Error getting multiple public keys:', error);
    res.status(500).json({ 
      error: 'Failed to get public keys' 
    });
  }
}

/**
 * Get users who have public keys (for user discovery)
 * GET /api/keys/users
 */
async function getUsersWithKeys(req, res) {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100
    const offset = parseInt(req.query.offset) || 0;
    
    const users = await keyManagementService.getUsersWithKeys(userId, limit, offset);
    
    const response = users.map(user => ({
      userId: user.id,
      username: user.username,
      fingerprint: user.key_fingerprint,
      keyCreatedAt: user.created_at
    }));

    res.json({ 
      users: response,
      pagination: {
        limit,
        offset,
        hasMore: response.length === limit
      }
    });
  } catch (error) {
    console.error('Error getting users with keys:', error);
    res.status(500).json({ 
      error: 'Failed to get users' 
    });
  }
}

/**
 * Verify key fingerprint
 * POST /api/keys/verify
 */
async function verifyKeyFingerprint(req, res) {
  try {
    const { userId, fingerprint } = req.body;
    
    if (!userId || !fingerprint) {
      return res.status(400).json({ 
        error: 'userId and fingerprint are required' 
      });
    }

    const isValid = await keyManagementService.verifyKeyFingerprint(
      parseInt(userId), 
      fingerprint
    );
    
    res.json({ 
      valid: isValid,
      userId: parseInt(userId),
      fingerprint
    });
  } catch (error) {
    console.error('Error verifying key fingerprint:', error);
    res.status(500).json({ 
      error: 'Failed to verify fingerprint' 
    });
  }
}

/**
 * Delete user's public key
 * DELETE /api/keys/me
 */
async function deleteMyPublicKey(req, res) {
  try {
    const userId = req.user.id;
    
    const deleted = await keyManagementService.deleteUserPublicKey(userId);
    
    if (!deleted) {
      return res.status(404).json({ 
        error: 'No public key found to delete' 
      });
    }

    res.json({ 
      success: true,
      message: 'Public key deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting public key:', error);
    res.status(500).json({ 
      error: 'Failed to delete public key' 
    });
  }
}

/**
 * Get key management statistics (admin only)
 * GET /api/keys/stats
 */
async function getKeyStats(req, res) {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        error: 'Admin access required' 
      });
    }

    const stats = await keyManagementService.getKeyStatistics();
    
    res.json({ 
      stats: {
        totalKeys: parseInt(stats.total_keys),
        keysCreatedLastWeek: parseInt(stats.keys_created_last_week),
        keysUpdatedLastWeek: parseInt(stats.keys_updated_last_week),
        oldestKey: stats.oldest_key,
        newestKey: stats.newest_key
      }
    });
  } catch (error) {
    console.error('Error getting key statistics:', error);
    res.status(500).json({ 
      error: 'Failed to get statistics' 
    });
  }
}

module.exports = {
  storePublicKey,
  getMyPublicKey,
  getUserPublicKey,
  getMultiplePublicKeys,
  getUsersWithKeys,
  verifyKeyFingerprint,
  deleteMyPublicKey,
  getKeyStats
};