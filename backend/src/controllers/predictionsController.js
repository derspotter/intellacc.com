// backend/src/controllers/predictionsController.js

const db = require('../db');

// Get all predictions for current user
exports.getUserPredictions = async (req, res) => {
  const userId = req.user.userId;

  try {
    let query = "SELECT * FROM predictions WHERE user_id = $1";
    let values = [userId];

    // Optional Filtering: Allow filtering by `status=resolved` or `status=pending`
    if (req.query.status === "resolved") {
      query += " AND outcome IS NOT NULL";
    } else if (req.query.status === "pending") {
      query += " AND outcome IS NULL";
    }

    // Add sorting
    query += " ORDER BY created_at DESC";

    const result = await db.query(query, values);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching predictions:", err);
    res.status(500).send("Database error: " + err.message);
  }
};

// Create a new prediction
exports.createPrediction = async (req, res) => {
  const { event_id, prediction_value, confidence } = req.body;
  const userId = req.user.userId;

  try {
    // Fetch the event title
    const eventQuery = await db.query("SELECT title FROM events WHERE id = $1", [event_id]);

    if (eventQuery.rows.length === 0) {
      return res.status(400).json({ message: "Invalid event_id" });
    }

    const eventTitle = eventQuery.rows[0].title;

    // Insert prediction into database
    const result = await db.query(
      "INSERT INTO predictions (user_id, event_id, event, prediction_value, confidence) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [userId, event_id, eventTitle, prediction_value, confidence]
    );

    // Emit socket event for real-time updates
    if (req.app.get('io')) {
      req.app.get('io').emit('newPrediction', result.rows[0]);
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error saving prediction:", err);
    res.status(500).send("Database error: " + err.message);
  }
};

// Create a new event
exports.createEvent = async (req, res) => {
  const { title, details, closing_date } = req.body;

  try {
    const result = await db.query(
      "INSERT INTO events (title, details, closing_date) VALUES ($1, $2, $3) RETURNING *",
      [title, details, closing_date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error creating event:", err);
    res.status(500).send("Database error: " + err.message);
  }
};

// Get all available events
exports.getEvents = async (req, res) => {
  console.log('getEvents called');
  try {
    console.log('User ID:', req.user.userId);
    const result = await db.query(
      "SELECT * FROM events WHERE outcome IS NULL AND closing_date > NOW() ORDER BY closing_date ASC"
    );
    console.log('Events result:', result.rows);
    if (result.rows.length === 0) {
      console.log('No events found');
      res.status(404).json({ message: "No events found" });
    } else {
      res.status(200).json(result.rows);
    }
  } catch (err) {
    console.error("Error fetching events:", err);
    res.status(500).send("Database error: " + err.message);
  }
};

// Resolve a prediction (admin only)
exports.resolvePrediction = async (req, res) => {
  const { outcome } = req.body; // Should be "correct" or "incorrect"
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    // Check if the user is an admin
    const adminCheck = await db.query("SELECT role FROM users WHERE id = $1", [userId]);
    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== "admin") {
      return res.status(403).json({ message: "Only admins can resolve predictions." });
    }

    // Check if prediction exists
    const predictionQuery = await db.query("SELECT * FROM predictions WHERE id = $1", [id]);
    if (predictionQuery.rows.length === 0) {
      return res.status(404).json({ message: "Prediction not found" });
    }

    // Update prediction outcome
    const result = await db.query(
      "UPDATE predictions SET outcome = $1, resolved_at = NOW() WHERE id = $2 RETURNING *",
      [outcome, id]
    );

    // Emit socket event for real-time updates
    if (req.app.get('io')) {
      req.app.get('io').emit('predictionResolved', result.rows[0]);
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error resolving prediction:", err);
    res.status(500).send("Database error: " + err.message);
  }
};

// Get assigned predictions for current user
exports.getAssignedPredictions = async (req, res) => {
  const userId = req.user.userId;
  
  try {
    const result = await db.query(
      `SELECT
        ap.*,
        p.event,
        p.prediction_value,
        p.outcome,
        p.event_id -- Add event_id here
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
    await db.query('BEGIN');
    
    // Check if assignment exists and belongs to the user
    const assignmentCheck = await db.query(
      `SELECT ap.* FROM assigned_predictions ap
       WHERE ap.id = $1 AND ap.user_id = $2 AND ap.completed = FALSE`,
      [assignmentId, userId]
    );
    
    if (assignmentCheck.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: "Assignment not found or already completed" });
    }
    
    const assignment = assignmentCheck.rows[0];
    
    // Check if prediction is still open
    const predictionCheck = await db.query(
      'SELECT * FROM predictions WHERE id = $1 AND outcome IS NULL',
      [assignment.prediction_id]
    );
    
    if (predictionCheck.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ message: "Prediction is already resolved" });
    }
    
    // Check if user already bet on this prediction
    const betCheck = await db.query(
      'SELECT * FROM bets WHERE user_id = $1 AND prediction_id = $2',
      [userId, assignment.prediction_id]
    );
    
    if (betCheck.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ message: "You already placed a bet on this prediction" });
    }
    
    // Create bet record
    const betResult = await db.query(
      `INSERT INTO bets 
       (user_id, prediction_id, confidence_level, bet_on, created_at, assignment_id) 
       VALUES ($1, $2, $3, $4, NOW(), $5) 
       RETURNING *`,
      [userId, assignment.prediction_id, confidenceLevel, betOn, assignmentId]
    );
    
    // Mark assignment as completed
    await db.query(
      `UPDATE assigned_predictions 
       SET completed = TRUE, completed_at = NOW() 
       WHERE id = $1`,
      [assignmentId]
    );
    
    // Commit transaction
    await db.query('COMMIT');
    
    // Emit socket event for real-time updates
    if (req.app.get('io')) {
      req.app.get('io').emit('newBet', betResult.rows[0]);
    }
    
    res.status(201).json({
      message: "Bet placed successfully",
      bet: betResult.rows[0]
    });
    
  } catch (err) {
    await db.query('ROLLBACK');
    console.error("Error placing bet:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get betting statistics for the current month
exports.getMonthlyBettingStats = async (req, res) => {
  const userId = req.user.userId;
  
  try {
    // Get current month-year
    const currentDate = new Date();
    const monthYear = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
    
    const result = await db.query(
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

// Assign a prediction to a specific user (Admin only)
exports.assignPredictions = async (req, res) => {
  const { prediction_id, target_user_id } = req.body;
  const requesting_user_id = req.user.userId;

  // Basic Input Validation
  if (!prediction_id || !target_user_id) {
    return res.status(400).json({ message: "Missing prediction_id or target_user_id in request body." });
  }

  try {
    // 1. Check if the requesting user is an admin
    const adminCheck = await db.query("SELECT role FROM users WHERE id = $1", [requesting_user_id]);
    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== "admin") {
      return res.status(403).json({ message: "Only admins can assign predictions." });
    }

    // Start transaction
    await db.query('BEGIN');

    // 2. Check if the target user exists
    const targetUserCheck = await db.query("SELECT id FROM users WHERE id = $1", [target_user_id]);
    if (targetUserCheck.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: `Target user with ID ${target_user_id} not found.` });
    }

    // 3. Check if the prediction exists and is not resolved
    const predictionCheck = await db.query("SELECT id FROM predictions WHERE id = $1 AND outcome IS NULL", [prediction_id]);
    if (predictionCheck.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: `Prediction with ID ${prediction_id} not found or is already resolved.` });
    }

    // 4. Check if this prediction is already assigned to this user and not completed
    const existingAssignmentCheck = await db.query(
      "SELECT id FROM assigned_predictions WHERE prediction_id = $1 AND user_id = $2 AND completed = FALSE",
      [prediction_id, target_user_id]
    );
    if (existingAssignmentCheck.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ message: "This prediction is already assigned to this user and is pending completion." });
    }

    // 5. Insert the new assignment
    const result = await db.query(
      "INSERT INTO assigned_predictions (user_id, prediction_id) VALUES ($1, $2) RETURNING *",
      [target_user_id, prediction_id]
    );

    // Commit transaction
    await db.query('COMMIT');

    // Optionally: Emit a socket event to notify the target user
    // if (req.app.get('io')) { ... }

    res.status(201).json(result.rows[0]);

  } catch (err) {
    await db.query('ROLLBACK'); // Rollback on any error
    console.error("Error assigning prediction:", err);
    res.status(500).send("Database error: " + err.message);
  }
};

// ADMIN: Delete all predictions (for testing only)
exports.deleteAllPredictions = async (req, res) => {
  const userId = req.user.userId;
  // Check if the user is an admin
  const adminCheck = await db.query("SELECT role FROM users WHERE id = $1", [userId]);
  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== "admin") {
    return res.status(403).json({ message: "Only admins can delete all predictions." });
  }
  try {
    await db.query("DELETE FROM predictions");
    res.status(200).json({ message: "All predictions deleted." });
  } catch (err) {
    console.error("Error deleting all predictions:", err);
    res.status(500).json({ message: "Database error: " + err.message });
  }
};