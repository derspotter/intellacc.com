// backend/src/controllers/userController.js

const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateToken } = require('../utils/jwt');
const { isRegistrationEnabled, REGISTRATION_CLOSED_MESSAGE } = require('../utils/registration');
const notificationService = require('../services/notificationService');
const emailVerificationService = require('../services/emailVerificationService');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');

const removeAttachmentFile = (storagePath) => {
  if (!storagePath) return;
  const filePath = path.join(UPLOADS_DIR, storagePath);
  fs.unlink(filePath, (err) => {
    if (err) {
      console.error('Failed to remove attachment file:', err);
    }
  });
};

// Create a new user
exports.createUser = async (req, res) => {
  if (!isRegistrationEnabled()) {
    return res.status(403).json({ message: REGISTRATION_CLOSED_MESSAGE });
  }

  const { username, email, password } = req.body;
  
  // Validate required fields
  if (!username || !email || !password) {
    return res.status(400).json({ 
      message: 'Username, email, and password are required' 
    });
  }
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      message: 'Please provide a valid email address' 
    });
  }
  
  // Validate password length
  if (password.length < 6) {
    return res.status(400).json({ 
      message: 'Password must be at least 6 characters long' 
    });
  }
  
  try {
    // Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ 
        message: 'User with this email or username already exists' 
      });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (username, email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, username, email, created_at',
      [username, email, hashedPassword]
    );

    const newUser = result.rows[0];

    // Send verification email (async, don't block response)
    emailVerificationService.sendVerificationEmail(newUser.id, newUser.email)
      .then(() => console.log(`[Signup] Verification email sent to ${newUser.email}`))
      .catch(err => console.error(`[Signup] Failed to send verification email:`, err));

    res.status(201).json({
      user: newUser,
      message: 'Account created! Please check your email to verify your account.'
    });
  } catch (err) {
    console.error('User creation error:', err);
    
    // Handle database constraint errors
    if (err.code === '23505') { // Unique constraint violation
      return res.status(400).json({ 
        message: 'User with this email or username already exists' 
      });
    }
    
    res.status(500).json({ message: 'Error creating user' });
  }
};

// Get a user by ID
exports.getUser = async (req, res) => {
  const userId = req.params.id;
  try {
    const result = await db.query('SELECT id, username, email, bio, created_at, updated_at FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching user' });
  }
};

// Get a user by username
exports.getUserByUsername = async (req, res) => {
  const username = req.params.username;
  try {
    const result = await db.query('SELECT id, username, email, bio, created_at, updated_at FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL', [username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching user' });
  }
};

// Search users by username or ID
exports.searchUsers = async (req, res) => {
  const query = req.query.q || '';
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);
  const messagingReadyOnly = req.query.messaging_ready === '1' || req.query.messaging_ready === 'true';

  if (!query.trim()) {
    return res.json([]);
  }

  try {
    const whereMessagingReady = messagingReadyOnly
      ? `
        AND EXISTS (
          SELECT 1
          FROM user_devices ud
          JOIN mls_key_packages kp
            ON kp.user_id = u.id
           AND kp.device_id = ud.device_public_id::text
          WHERE ud.user_id = u.id
            AND ud.revoked_at IS NULL
            AND (kp.not_before IS NULL OR kp.not_before <= NOW())
            AND (kp.not_after IS NULL OR kp.not_after > NOW())
        )
      `
      : '';

    const result = await db.query(`
      SELECT u.id, u.username, u.bio, u.created_at
      FROM users u
      WHERE (LOWER(u.username) LIKE $1 OR u.id::text = $2)
        AND u.id != $3
        AND u.deleted_at IS NULL
        ${whereMessagingReady}
      ORDER BY u.username
      LIMIT $4
    `, [`%${query.toLowerCase()}%`, query, req.user.id, limit]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching users:', err);
    res.status(500).json({ message: 'Error searching users' });
  }
};

// Login a user
exports.loginUser = async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'User not found' });
    }

    const user = result.rows[0];
    if (user.deleted_at) {
      return res.status(403).json({ message: 'Account has been deleted' });
    }
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(400).json({ message: 'Incorrect password' });
    }

    // Use the centralized JWT utility to generate a token
    const token = generateToken({
      userId: user.id,
      role: user.role || 'user'
    });
    
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error logging in' });
  }
};

// Get current user profile
exports.getUserProfile = async (req, res) => {
  try {
    const userId = req.user.id; // Using standardized user object from auth middleware

    const result = await db.query(
      "SELECT id, username, email, role, bio, (rp_balance_ledger::DOUBLE PRECISION / 1000000.0) AS rp_balance FROM users WHERE id = $1 AND deleted_at IS NULL",
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]); // Return user profile (excluding password)
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// Edit user profile
exports.editUserProfile = async (req, res) => {
  const userId = req.user.id; // Using standardized user object
  const { username, bio } = req.body || {};

  try {
    const fields = [];
    const values = [];

    if (typeof username !== 'undefined') {
      const trimmedUsername = String(username).trim();
      if (!trimmedUsername) {
        return res.status(400).json({ message: 'Username cannot be empty' });
      }

      const existing = await db.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2 AND deleted_at IS NULL',
        [trimmedUsername, userId]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ message: 'Username is already taken' });
      }

      fields.push('username');
      values.push(trimmedUsername);
    }

    if (typeof bio !== 'undefined') {
      fields.push('bio');
      values.push(bio);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No profile fields provided' });
    }

    const setClauses = fields.map((field, index) => `${field} = $${index + 1}`);
    setClauses.push('updated_at = NOW()');

    const result = await db.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${values.length + 1} RETURNING id, username, email, role, bio, updated_at`,
      [...values, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error updating profile' });
  }
};

// Delete account (soft delete + anonymize)
exports.deleteAccount = async (req, res) => {
  const userId = req.user.id;
  const { password } = req.body || {};
  const pool = db.getPool();
  const client = await pool.connect();

  try {
    if (!password) {
      client.release();
      return res.status(400).json({ message: 'Password is required' });
    }

    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT id, password_hash, deleted_at FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ message: 'User not found' });
    }

    if (userRes.rows[0].deleted_at) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ message: 'Account already deleted' });
    }

    const match = await bcrypt.compare(password, userRes.rows[0].password_hash);
    if (!match) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ message: 'Incorrect password' });
    }

    const deletedUsername = `deleted_user_${userId}`;
    const deletedEmail = `deleted_${userId}_${Date.now()}@example.invalid`;
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    const attachmentsRes = await client.query(
      'SELECT id, storage_path FROM attachments WHERE owner_id = $1',
      [userId]
    );
    const attachmentIds = attachmentsRes.rows.map(row => row.id);
    if (attachmentIds.length > 0) {
      await client.query(
        'UPDATE posts SET image_attachment_id = NULL WHERE image_attachment_id = ANY($1::int[])',
        [attachmentIds]
      );
    }

    await client.query(
      'UPDATE posts SET image_url = NULL, image_attachment_id = NULL WHERE user_id = $1',
      [userId]
    );

    await client.query('DELETE FROM attachments WHERE owner_id = $1', [userId]);
    await client.query('DELETE FROM likes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM follows WHERE follower_id = $1 OR following_id = $1', [userId]);
    await client.query('DELETE FROM notifications WHERE user_id = $1 OR actor_id = $1', [userId]);
    await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM notification_preferences WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_reputation WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_visibility_score WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_verifications WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM webauthn_credentials WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM device_linking_tokens WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_devices WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_master_keys WHERE user_id = $1', [userId]);

    await client.query('SELECT clear_user_mls_data($1)', [userId]);
    await client.query('UPDATE mls_groups SET created_by = NULL WHERE created_by = $1', [userId]);

    await client.query(
      `UPDATE users
       SET username = $1,
           email = $2,
           bio = NULL,
           password_hash = $3,
           role = $4,
           deletion_requested_at = NOW(),
           deleted_at = NOW(),
           password_changed_at = NOW(),
           updated_at = NOW()
       WHERE id = $5`,
      [deletedUsername, deletedEmail, hashedPassword, 'deleted', userId]
    );

    await client.query('COMMIT');
    client.release();

    for (const row of attachmentsRes.rows) {
      removeAttachmentFile(row.storage_path);
    }

    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    client.release();
    console.error('Error deleting account:', err);
    res.status(500).json({ message: 'Error deleting account' });
  }
};

// Follow a user
exports.followUser = async (req, res) => {
  const followerId = req.user.id; // Using standardized user object
  const followingId = req.params.id;
  
  // Check if user is trying to follow themselves
  if (followerId === parseInt(followingId)) {
    return res.status(400).json({ message: "You cannot follow yourself" });
  }
  
  try {
    // Check if user exists
    const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [followingId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Check if already following
    const followCheck = await db.query(
      'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId]
    );
    
    if (followCheck.rows.length > 0) {
      return res.status(400).json({ message: "Already following this user" });
    }
    
    // Create follow relationship
    const result = await db.query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) RETURNING *',
      [followerId, followingId]
    );
    
    // Create follow notification
    try {
      await notificationService.createFollowNotification(followerId, followingId);
    } catch (notificationError) {
      console.error('Error creating follow notification:', notificationError);
      // Don't fail the follow operation if notification fails
    }
    
    res.status(201).json({ message: "Successfully followed user" });
  } catch (err) {
    console.error("Error following user:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Unfollow a user
exports.unfollowUser = async (req, res) => {
  const followerId = req.user.id; // Using standardized user object
  const followingId = req.params.id;
  
  try {
    const result = await db.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING *',
      [followerId, followingId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "You are not following this user" });
    }
    
    res.status(200).json({ message: "Successfully unfollowed user" });
  } catch (err) {
    console.error("Error unfollowing user:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Check if current user follows a specific user
exports.getFollowingStatus = async (req, res) => {
  const currentUserId = req.user?.id ?? req.user?.userId;
  const targetUserId = parseInt(req.params.id, 10);

  if (!currentUserId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (isNaN(targetUserId)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
    const result = await db.query(
      'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
      [currentUserId, targetUserId]
    );

    res.status(200).json({ isFollowing: result.rows.length > 0 });
  } catch (err) {
    console.error("Error checking follow status:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get followers of a user
exports.getFollowers = async (req, res) => {
  const userIdParam = req.params.id;
  const userId = parseInt(userIdParam, 10);

  if (isNaN(userId)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }
  
  try {
    const result = await db.query(
      `SELECT u.id, u.username 
      FROM follows f 
      JOIN users u ON f.follower_id = u.id 
      WHERE f.following_id = $1`,
      [userId]
    );
    
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error getting followers:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get users that a user is following
exports.getFollowing = async (req, res) => {
  const userId = req.params.id;
  
  try {
    const result = await db.query(
      `SELECT u.id, u.username 
      FROM follows f 
      JOIN users u ON f.following_id = u.id 
      WHERE f.follower_id = $1`,
      [userId]
    );
    
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error getting following:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get user's portfolio positions
exports.getUserPositions = async (req, res) => {
  try {
    const requestedId = parseInt(req.params.id, 10);
    const authedUserId = req.user?.id ?? req.user?.userId;

    // Require auth and only allow fetching own positions
    if (!authedUserId) {
      return res.status(401).json({ message: 'Unauthorized: No authenticated user' });
    }
    if (authedUserId !== requestedId) {
      return res.status(403).json({ message: 'Forbidden: Cannot access other users\' positions' });
    }

    console.log('🔍 getUserPositions for userId:', authedUserId);
    
    const result = await db.query(`
      SELECT 
        us.event_id,
        us.yes_shares,
        us.no_shares,
        e.title as event_title,
        'General'::text AS category,
        e.closing_date,
        e.market_prob,
        e.cumulative_stake
      FROM user_shares us
      JOIN events e ON us.event_id = e.id
      WHERE us.user_id = $1 
        AND (us.yes_shares > 0 OR us.no_shares > 0)
      ORDER BY us.last_updated DESC
    `, [authedUserId]);
    
    console.log('🔍 Found', result.rows.length, 'positions for user', authedUserId);
        
        res.status(200).json(result.rows);
        
      } catch (err) {
        console.error('Error fetching user positions:', err);
        res.status(500).json({ message: 'Error fetching user positions' });
      }
    };
    
    // Change user password
    exports.changePassword = async (req, res) => {
      const userId = req.user.id;
      const { oldPassword, newPassword } = req.body;
      
      if (!oldPassword || !newPassword) {
        return res.status(400).json({ message: 'Old and new passwords are required' });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters long' });
      }
      
      try {
        const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) {
          return res.status(404).json({ message: 'User not found' });
        }
        
        const user = result.rows[0];
        const match = await bcrypt.compare(oldPassword, user.password_hash);
        
        if (!match) {
          return res.status(400).json({ message: 'Incorrect old password' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await db.query(
          'UPDATE users SET password_hash = $1, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2',
          [hashedPassword, userId]
        );
        
        res.status(200).json({ message: 'Password updated successfully' });
      } catch (err) {
        console.error('Error changing password:', err);
        res.status(500).json({ message: 'Error changing password' });
      }
    };
    
    // Note: Removed the following duplicated functions that should be in predictionsController.js:
    // - resolvePrediction
    // - getPredictions
    // - assignPredictions
    // - getAssignedPredictions
    // - placeBet
    // - getMonthlyBettingStats
    
// Get encrypted master key
exports.getMasterKey = async (req, res) => {
  const userId = req.user.id;
  const deviceIdsHeader = req.headers['x-device-ids'];

  try {
    // 1. Verify Device Trust
    // If no devices provided, we can't verify. New device? 
    // If new device, they don't have a local ID yet. They are setting up.
    // They shouldn't be calling getMasterKey? They should call setMasterKey?
    // No, if they are setting up a NEW device on an EXISTING account, they need the key!
    // But they are not trusted yet.
    // So they MUST Link first.
    
    // Check key last updated time
    const keyRes = await db.query('SELECT wrapped_key, salt, iv, updated_at FROM user_master_keys WHERE user_id = $1', [userId]);
    if (keyRes.rows.length === 0) return res.status(404).json({ error: 'Key not found' }); // User has no key (first device)
    
    const masterKey = keyRes.rows[0];
    const keyUpdatedAt = new Date(masterKey.updated_at);

    if (!deviceIdsHeader) {
        // No local devices found (clean browser). New Device logic.
        // Must Link to get key.
        return res.status(403).json({ error: 'Device verification required', code: 'LINK_REQUIRED' });
    }

    const deviceIds = deviceIdsHeader.split(',');

    // Check if any of the provided IDs are trusted
    const deviceRes = await db.query(
        `SELECT id, device_public_id, last_verified_at FROM user_devices
         WHERE user_id = $1 AND device_public_id = ANY($2::uuid[])`,
        [userId, deviceIds]
    );

    const trustedDevice = deviceRes.rows.find(d => {
        if (!d.last_verified_at) return false; // Never verified
        return new Date(d.last_verified_at) >= keyUpdatedAt; // Verified AFTER last key rotation
    });

    if (!trustedDevice) {
        return res.status(403).json({ error: 'Device verification required', code: 'LINK_REQUIRED' });
    }

    // Success
    res.json({
        ...masterKey,
        deviceId: trustedDevice.device_public_id // Tell client which ID worked
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch master key' });
  }
};

// Set/Update encrypted master key
exports.setMasterKey = async (req, res) => {
  const userId = req.user.id;
  const { 
      wrapped_key, salt, iv, 
      wrapped_key_prf, salt_prf, iv_prf 
  } = req.body;

  if (!wrapped_key && !wrapped_key_prf) {
      return res.status(400).json({ error: 'Missing key data' });
  }
  
  try {
    // Check existence
    const existCheck = await db.query('SELECT 1 FROM user_master_keys WHERE user_id = $1', [userId]);
    const exists = existCheck.rows.length > 0;

    let query = '';
    let params = [];

    if (exists) {
        // Build dynamic UPDATE
        const updates = [];
        params.push(userId); // $1
        let idx = 2;

        if (wrapped_key && salt && iv) {
            updates.push(`wrapped_key = $${idx++}, salt = $${idx++}, iv = $${idx++}`);
            params.push(wrapped_key, salt, iv);
        }
        if (wrapped_key_prf && salt_prf && iv_prf) {
            updates.push(`wrapped_key_prf = $${idx++}, salt_prf = $${idx++}, iv_prf = $${idx++}`);
            params.push(wrapped_key_prf, salt_prf, iv_prf);
        }
        updates.push(`updated_at = NOW()`); // Always update timestamp (triggers verification requirement?)
        // Wait, if we only add PRF, do we want to trigger verification for other devices?
        // Yes, rotating keys usually implies verification.
        // But adding a passkey shouldn't lock out your phone?
        // Maybe updated_at only on MAIN key rotation?
        // For simplicity, any write updates timestamp.

        if (updates.length === 0) return res.json({ success: true }); // Nothing to do

        query = `UPDATE user_master_keys SET ${updates.join(', ')} WHERE user_id = $1`;
    } else {
        // INSERT (First time setup)
        // Must have Password wrapping at least? Not necessarily, but usually yes.
        // We'll allow partial insert if schema allows nulls (it does).
        query = `
            INSERT INTO user_master_keys 
            (user_id, wrapped_key, salt, iv, wrapped_key_prf, salt_prf, iv_prf, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        `;
        params = [
            userId,
            wrapped_key || null, salt || null, iv || null,
            wrapped_key_prf || null, salt_prf || null, iv_prf || null
        ];
    }

    await db.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save master key' });
  }
};
