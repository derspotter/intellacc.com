// backend/src/controllers/predictionsController.js

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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

    const result = await pool.query(query, values);
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
    const eventQuery = await pool.query("SELECT title FROM events WHERE id = $1", [event_id]);

    if (eventQuery.rows.length === 0) {
      return res.status(400).json({ message: "Invalid event_id" });
    }

    const eventTitle = eventQuery.rows[0].title;

    // Insert prediction into database
    const result = await pool.query(
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
    const result = await pool.query(
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
  try {
    const result = await pool.query(
      "SELECT * FROM events WHERE outcome IS NULL AND closing_date > NOW() ORDER BY closing_date ASC"
    );
    res.status(200).json(result.rows);
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
    const adminCheck = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== "admin") {
      return res.status(403).json({ message: "Only admins can resolve predictions." });
    }

    // Check if prediction exists
    const predictionQuery = await pool.query("SELECT * FROM predictions WHERE id = $1", [id]);
    if (predictionQuery.rows.length === 0) {
      return res.status(404).json({ message: "Prediction not found" });
    }

    // Update prediction outcome
    const result = await pool.query(
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
    
    // Emit socket event for real-time updates
    if (req.app.get('io')) {
      req.app.get('io').emit('newBet', betResult.rows[0]);
    }
    
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

// Get betting statistics for the current month
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