// backend/src/controllers/userController.js

const { Pool } = require('pg');


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create a new user
const bcrypt = require('bcrypt');
exports.createUser = async (req, res) => {
  const { username, email, password } = req.body;  // Change "password_hash" to "password"
  try {
    const hashedPassword = await bcrypt.hash(password, 10); // Hash the password before storing
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
      [username, email, hashedPassword]  // Save hashed password
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating user');
  }
};


// Get a user by ID
exports.getUser = async (req, res) => {
  const userId = req.params.id;
  try {
    const result = await pool.query('SELECT id, username, email, created_at, updated_at FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).send('User not found');
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching user');
  }
};

const jwt = require('jsonwebtoken');


// Login a user
exports.loginUser = async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(400).send('Incorrect password');
    }

    const token = jwt.sign({ userId: user.id }, 'your_jwt_secret', { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error logging in');
  }
};


exports.getUserProfile = async (req, res) => {
  try {
    const userId = req.user.userId; // Extract user ID from token

    const result = await pool.query(
      "SELECT id, username, email, role FROM users WHERE id = $1",
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

exports.resolvePrediction = async (req, res) => {
  const { outcome } = req.body; // ✅ Should be "correct" or "incorrect"
  const { id } = req.params;
  const userId = req.user.userId;

  try {
      // ✅ Check if the user is an admin
      const adminCheck = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
      if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== "admin") {
          return res.status(403).json({ message: "Only admins can resolve predictions." });
      }

      // ✅ Check if prediction exists
      const predictionQuery = await pool.query("SELECT * FROM predictions WHERE id = $1", [id]);
      if (predictionQuery.rows.length === 0) {
          return res.status(404).json({ message: "Prediction not found" });
      }

      // ✅ Update prediction outcome
      const result = await pool.query(
          "UPDATE predictions SET outcome = $1, resolved_at = NOW() WHERE id = $2 RETURNING *",
          [outcome, id]
      );

      res.status(200).json(result.rows[0]);
  } catch (err) {
      console.error("Error resolving prediction:", err);
      res.status(500).send("Database error: " + err.message);
  }
};


exports.getPredictions = async (req, res) => {
  const userId = req.user.userId; // ✅ Get the logged-in user's ID from the JWT token

  try {
      let query = "SELECT * FROM predictions WHERE user_id = $1";
      let values = [userId];

      // ✅ Optional Filtering: Allow filtering by `status=resolved`
      if (req.query.status === "resolved") {
          query += " AND outcome IS NOT NULL";
      } else if (req.query.status === "pending") {
          query += " AND outcome IS NULL";
      }

      const result = await pool.query(query, values);
      res.status(200).json(result.rows);
  } catch (err) {
      console.error("Error fetching predictions:", err);
      res.status(500).send("Database error: " + err.message);
  }
};

// Add this new function to your userController

exports.editUserProfile = async (req, res) => {
  const userId = req.user.userId;
  const { bio } = req.body;
  
  try {
    const result = await pool.query(
      'UPDATE users SET bio = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [bio, userId]
    );
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating profile');
  }
};

// Follow a user
exports.followUser = async (req, res) => {
  const followerId = req.user.userId;
  const followingId = req.params.id;
  
  // Check if user is trying to follow themselves
  if (followerId === parseInt(followingId)) {
    return res.status(400).json({ message: "You cannot follow yourself" });
  }
  
  try {
    // Check if user exists
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [followingId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Check if already following
    const followCheck = await pool.query(
      'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId]
    );
    
    if (followCheck.rows.length > 0) {
      return res.status(400).json({ message: "Already following this user" });
    }
    
    // Create follow relationship
    const result = await pool.query(
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
  const followerId = req.user.userId;
  const followingId = req.params.id;
  
  try {
    const result = await pool.query(
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
  const userId = req.params.id;
  
  try {
    const result = await pool.query(
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
    const result = await pool.query(
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

// Assign predictions to a user (admin/system function)
exports.assignPredictions = async (req, res) => {
  const { userId, count = 5 } = req.body;
  
  if (!userId) {
    return res.status(400).json({ message: "userId is required" });
  }
  
  try {
    // Check if user exists
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Get current month-year
    const currentDate = new Date();
    const monthYear = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
    
    // Check how many predictions are already assigned for this month
    const assignedCount = await pool.query(
      'SELECT COUNT(*) FROM assigned_predictions WHERE user_id = $1 AND month_year = $2',
      [userId, monthYear]
    );
    
    const alreadyAssigned = parseInt(assignedCount.rows[0].count);
    const neededAssignments = Math.max(0, count - alreadyAssigned);
    
    if (neededAssignments === 0) {
      return res.status(200).json({ 
        message: `User already has ${alreadyAssigned} predictions assigned this month`,
        assigned: []
      });
    }
    
    // Get suitable predictions (not yet resolved, not yet assigned to this user)
    const availablePredictions = await pool.query(
      `SELECT p.id FROM predictions p
       WHERE p.outcome IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM assigned_predictions ap
         WHERE ap.prediction_id = p.id AND ap.user_id = $1
       )
       ORDER BY RANDOM()
       LIMIT $2`,
      [userId, neededAssignments]
    );
    
    if (availablePredictions.rows.length === 0) {
      return res.status(404).json({ message: "No suitable predictions available" });
    }
    
    // Assign predictions to user
    const assignedPredictions = [];
    
    for (const pred of availablePredictions.rows) {
      const result = await pool.query(
        `INSERT INTO assigned_predictions 
         (user_id, prediction_id, assigned_at, month_year) 
         VALUES ($1, $2, NOW(), $3) 
         RETURNING *`,
        [userId, pred.id, monthYear]
      );
      
      assignedPredictions.push(result.rows[0]);
    }
    
    res.status(201).json({
      message: `Successfully assigned ${assignedPredictions.length} predictions`,
      assigned: assignedPredictions
    });
    
  } catch (err) {
    console.error("Error assigning predictions:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get user's assigned predictions
exports.getAssignedPredictions = async (req, res) => {
  const userId = req.user.userId;
  
  try {
    const result = await pool.query(
      `SELECT 
        ap.*,
        p.event,
        p.prediction_value,
        p.outcome
      FROM 
        assigned_predictions ap
      JOIN 
        predictions p ON ap.prediction_id = p.id
      WHERE 
        ap.user_id = $1 AND ap.completed = FALSE AND p.outcome IS NULL
      ORDER BY 
        ap.assigned_at ASC`,
      [userId]
    );
    
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error getting assigned predictions:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Place a bet on an assigned prediction
exports.placeBet = async (req, res) => {
  const userId = req.user.userId;
  const assignmentId = req.params.id;
  const { confidenceLevel, betOn } = req.body;
  
  // Validate confidence level
  if (!confidenceLevel || confidenceLevel < 1 || confidenceLevel > 10) {
    return res.status(400).json({ 
      message: "Confidence level must be between 1 (lowest) and 10 (highest)" 
    });
  }
  
  if (!betOn) {
    return res.status(400).json({ message: "You must specify what you're betting on" });
  }
  
  try {
    // Start transaction
    await pool.query('BEGIN');
    
    // Check if assignment exists and belongs to the user
    const assignmentCheck = await pool.query(
      `SELECT ap.* FROM assigned_predictions ap
       WHERE ap.id = $1 AND ap.user_id = $2 AND ap.completed = FALSE`,
      [assignmentId, userId]
    );
    
    if (assignmentCheck.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ message: "Assignment not found or already completed" });
    }
    
    const assignment = assignmentCheck.rows[0];
    
    // Check if prediction is still open
    const predictionCheck = await pool.query(
      'SELECT * FROM predictions WHERE id = $1 AND outcome IS NULL',
      [assignment.prediction_id]
    );
    
    if (predictionCheck.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ message: "Prediction is already resolved" });
    }
    
    // Check if user already bet on this prediction
    const betCheck = await pool.query(
      'SELECT * FROM bets WHERE user_id = $1 AND prediction_id = $2',
      [userId, assignment.prediction_id]
    );
    
    if (betCheck.rows.length > 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ message: "You already placed a bet on this prediction" });
    }
    
    // Create bet record
    const betResult = await pool.query(
      `INSERT INTO bets 
       (user_id, prediction_id, confidence_level, bet_on, created_at, assignment_id) 
       VALUES ($1, $2, $3, $4, NOW(), $5) 
       RETURNING *`,
      [userId, assignment.prediction_id, confidenceLevel, betOn, assignmentId]
    );
    
    // Mark assignment as completed
    await pool.query(
      `UPDATE assigned_predictions 
       SET completed = TRUE, completed_at = NOW() 
       WHERE id = $1`,
      [assignmentId]
    );
    
    // Commit transaction
    await pool.query('COMMIT');
    
    res.status(201).json({
      message: "Bet placed successfully",
      bet: betResult.rows[0]
    });
    
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("Error placing bet:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get user's monthly betting stats
exports.getMonthlyBettingStats = async (req, res) => {
  const userId = req.user.userId;
  
  try {
    // Get current month-year
    const currentDate = new Date();
    const monthYear = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
    
    const result = await pool.query(
      `SELECT 
        COUNT(CASE WHEN completed = TRUE THEN 1 END) AS completed_bets,
        COUNT(*) AS total_assigned,
        5 - COUNT(CASE WHEN completed = TRUE THEN 1 END) AS remaining_bets
      FROM 
        assigned_predictions
      WHERE 
        user_id = $1 AND month_year = $2`,
      [userId, monthYear]
    );
    
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error getting monthly betting stats:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
