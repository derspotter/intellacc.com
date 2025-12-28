// backend/src/controllers/userController.js

const db = require('../db');
const bcrypt = require('bcryptjs');
const { generateToken } = require('../utils/jwt');
const notificationService = require('../services/notificationService');

// Create a new user
exports.createUser = async (req, res) => {
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
    res.status(201).json({ user: result.rows[0] });
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
    const result = await db.query('SELECT id, username, email, created_at, updated_at FROM users WHERE id = $1', [userId]);
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
    const result = await db.query('SELECT id, username, email, created_at, updated_at FROM users WHERE LOWER(username) = LOWER($1)', [username]);
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

  if (!query.trim()) {
    return res.json([]);
  }

  try {
    const result = await db.query(`
      SELECT id, username, bio, created_at
      FROM users
      WHERE (LOWER(username) LIKE $1 OR id::text = $2)
        AND id != $3
      ORDER BY username
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
      "SELECT id, username, email, role, rp_balance FROM users WHERE id = $1",
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
  const { username } = req.body; // Changed from bio to username
  
  try {
    const result = await db.query(
      'UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username, email, role',
      [username, userId]
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

// Note: Removed the following duplicated functions that should be in predictionsController.js:
// - resolvePrediction
// - getPredictions
// - assignPredictions
// - getAssignedPredictions
// - placeBet
// - getMonthlyBettingStats
