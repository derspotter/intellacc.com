// backend/src/controllers/userController.js

const db = require('../db');
const bcrypt = require('bcrypt');
const { generateToken } = require('../utils/jwt');

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
      "SELECT id, username, email, role, bio FROM users WHERE id = $1",
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
  const { bio } = req.body;
  
  try {
    const result = await db.query(
      'UPDATE users SET bio = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, email, role, bio',
      [bio, userId]
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
      `SELECT u.id, u.username, u.bio 
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
      `SELECT u.id, u.username, u.bio 
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

// Note: Removed the following duplicated functions that should be in predictionsController.js:
// - resolvePrediction
// - getPredictions
// - assignPredictions
// - getAssignedPredictions
// - placeBet
// - getMonthlyBettingStats