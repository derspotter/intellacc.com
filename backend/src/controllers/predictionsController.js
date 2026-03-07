const asyncHandler = require("../utils/asyncHandler");
// backend/src/controllers/predictionsController.js

const db = require('../db');
const { setEventEmbedding } = require('../services/openRouterMatcher/embeddingService');
const matchConfig = require('../services/openRouterMatcher/config');

const normalizeMarketOutcome = (raw) => {
  if (typeof raw === 'boolean') {
    return raw ? 'yes' : 'no';
  }

  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (normalized === 'yes' || normalized === 'y' || normalized === 'true' || normalized === '1') {
    return 'yes';
  }
  if (normalized === 'no' || normalized === 'n' || normalized === 'false' || normalized === '0') {
    return 'no';
  }

  return null;
};

const ALLOWED_EVENT_TYPES = new Set(['binary', 'multiple_choice', 'numeric', 'discrete', 'date']);

const normalizeEventType = (raw) => {
  const value = String(raw || 'binary').trim().toLowerCase();
  return ALLOWED_EVENT_TYPES.has(value) ? value : 'binary';
};

const ensureUniqueOutcomeKeys = (rows) => {
  const seen = new Map();
  return rows.map((row, idx) => {
    const fallbackKey = `choice_${idx + 1}`;
    const baseKey = String(row?.key || fallbackKey).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || fallbackKey;
    const count = seen.get(baseKey) || 0;
    seen.set(baseKey, count + 1);
    return {
      ...row,
      key: count === 0 ? baseKey : `${baseKey}_${count + 1}`
    };
  });
};

const normalizeOutcomeRows = (eventType, outcomes, numericBuckets) => {
  if (eventType === 'multiple_choice') {
    if (!Array.isArray(outcomes)) return [];
    return ensureUniqueOutcomeKeys(outcomes
      .map((item, idx) => {
        if (typeof item === 'string') {
          const label = item.trim();
          if (!label) return null;
          return {
            key: `choice_${idx + 1}`,
            label,
            sortOrder: idx,
            lowerBound: null,
            upperBound: null
          };
        }
        if (!item || typeof item !== 'object') return null;
        const label = String(item.label || '').trim();
        if (!label) return null;
        const key = String(item.key || `choice_${idx + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        return {
          key: key || `choice_${idx + 1}`,
          label,
          sortOrder: Number.isInteger(item.sort_order) ? item.sort_order : idx,
          lowerBound: null,
          upperBound: null
        };
      })
      .filter(Boolean));
  }

  if (eventType === 'numeric') {
    if (!Array.isArray(numericBuckets)) return [];
    return ensureUniqueOutcomeKeys(numericBuckets
      .map((bucket, idx) => {
        if (!bucket || typeof bucket !== 'object') return null;
        const lower = Number(bucket.lower_bound);
        const upper = Number(bucket.upper_bound);
        if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
          return null;
        }
        const label = String(bucket.label || `${lower} to ${upper}`).trim();
        return {
          key: String(bucket.key || `bucket_${idx + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || `bucket_${idx + 1}`,
          label,
          sortOrder: Number.isInteger(bucket.sort_order) ? bucket.sort_order : idx,
          lowerBound: lower,
          upperBound: upper
        };
      })
      .filter(Boolean));
  }

  return [];
};

const validateNumericBuckets = (rows) => {
  const sorted = [...rows].sort((a, b) => a.lowerBound - b.lowerBound || a.upperBound - b.upperBound);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].lowerBound < sorted[i - 1].upperBound) {
      return false;
    }
  }
  return true;
};

const seedEventOutcomes = async (client, eventId, eventType, outcomeRows) => {
  if (!Array.isArray(outcomeRows) || outcomeRows.length < 2) {
    return;
  }

  const prob = 1 / outcomeRows.length;
  
  const values = [];
  const placeholders = [];
  let paramIdx = 1;
  
  for (const row of outcomeRows) {
    values.push(eventId, row.key, row.label, row.sortOrder, row.lowerBound, row.upperBound);
    placeholders.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
  }

  // 1. Bulk insert event_outcomes
  const outcomeResult = await client.query(
    `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (event_id, outcome_key) DO UPDATE
     SET label = EXCLUDED.label,
         sort_order = EXCLUDED.sort_order,
         lower_bound = EXCLUDED.lower_bound,
         upper_bound = EXCLUDED.upper_bound,
         updated_at = NOW()
     RETURNING id`,
    values
  );

  // 2. Bulk insert event_outcome_states
  const statesValues = [];
  const statesPlaceholders = [];
  let statesParamIdx = 1;
  
  for (const row of outcomeResult.rows) {
    statesValues.push(eventId, row.id, 0.0, prob);
    statesPlaceholders.push(`($${statesParamIdx++}, $${statesParamIdx++}, $${statesParamIdx++}, $${statesParamIdx++})`);
  }

  await client.query(
    `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
     VALUES ${statesPlaceholders.join(', ')}
     ON CONFLICT (event_id, outcome_id) DO UPDATE
     SET q_value = EXCLUDED.q_value,
         prob = EXCLUDED.prob,
         updated_at = NOW()`,
    statesValues
  );

  if (eventType === 'multiple_choice' || eventType === 'numeric') {
    const primaryProb = prob;
    await client.query(
      `UPDATE events
       SET market_prob = $1,
           q_yes = 0.0,
           q_no = 0.0
       WHERE id = $2`,
      [primaryProb, eventId]
    );
  }
};

// Helper function to generate probability payloads for non-binary prediction inputs
function generateProbabilityVector(prediction_type, prediction_value, confidence, numerical_value, lower_bound, upper_bound) {
  switch (prediction_type) {
    case 'binary':
      // Convert confidence to probability vector
      const prob = confidence / 100.0;
      if (prediction_value.toLowerCase() === 'yes' || prediction_value.toLowerCase() === 'true') {
        return [prob, 1 - prob]; // [P(Yes), P(No)]
      } else {
        return [1 - prob, prob]; // [P(Yes), P(No)]
      }
      
    case 'multiple_choice':
      // For now, create uniform distribution with higher weight on selected choice
      // In practice, this would be handled by the frontend with proper probability inputs
      const numOptions = 4; // Default assumption, should be extracted from event metadata
      const selectedProb = confidence / 100.0;
      const remainingProb = (1 - selectedProb) / (numOptions - 1);
      const probs = new Array(numOptions).fill(remainingProb);
      // This is a simplified implementation - in practice we'd need to know which option was selected
      probs[0] = selectedProb; // Assume first option selected for simplicity
      return probs;
      
    case 'numeric':
    case 'discrete':
      // For numerical predictions, we store distribution parameters
      // This is a simplified representation - full implementation would use proper distributions
      if (lower_bound !== null && upper_bound !== null) {
        return {
          type: 'interval',
          point_estimate: numerical_value,
          lower_bound: lower_bound,
          upper_bound: upper_bound,
          confidence: confidence / 100.0
        };
      } else {
        return {
          type: 'point',
          estimate: numerical_value,
          confidence: confidence / 100.0
        };
      }
      
    case 'date':
      return {
        type: 'date',
        predicted_date: prediction_value,
        confidence: confidence / 100.0
      };
      
    default:
      // Fallback to binary
      const fallbackProb = confidence / 100.0;
      return [fallbackProb, 1 - fallbackProb];
  }
}

// Get all predictions for current user
exports.getUserPredictions = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

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
});

// Create a new prediction
exports.createPrediction = asyncHandler(async (req, res) => {
  const { 
    event_id, 
    prediction_value, 
    confidence, 
    prediction_type = 'binary',
    numerical_value,
    lower_bound,
    upper_bound,
    prob_vector
  } = req.body;
  const userId = req.user.userId;

  // Check if the user has already predicted this event
  const existingPrediction = await db.query(
    "SELECT id FROM predictions WHERE user_id = $1 AND event_id = $2",
    [userId, event_id]
  );

  if (existingPrediction.rows.length > 0) {
    return res.status(409).json({ message: "You have already made a prediction for this event." });
  }

  // Fetch the event title and type
  const eventQuery = await db.query("SELECT title, event_type FROM events WHERE id = $1", [event_id]);

  if (eventQuery.rows.length === 0) {
    return res.status(400).json({ message: "Invalid event_id" });
  }

  const eventTitle = eventQuery.rows[0].title;
  const eventType = eventQuery.rows[0].event_type || 'binary';

  // Validate prediction based on type
  if (eventType === 'numeric' || eventType === 'discrete') {
    if (!numerical_value) {
      return res.status(400).json({ message: "Numerical value is required for numerical predictions" });
    }
  }

  // Generate probability vector if not provided
  let finalProbVector = prob_vector;
  if (!finalProbVector) {
    finalProbVector = generateProbabilityVector(prediction_type, prediction_value, confidence, numerical_value, lower_bound, upper_bound);
  }

  // Insert prediction into database with probability vector
  const result = await db.query(
    `INSERT INTO predictions 
     (user_id, event_id, event, prediction_value, confidence, prediction_type, numerical_value, lower_bound, upper_bound, prob_vector) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
     RETURNING *`,
    [userId, event_id, eventTitle, prediction_value, confidence, eventType, numerical_value, lower_bound, upper_bound, JSON.stringify(finalProbVector)]
  );

  // Emit socket event for real-time updates
  if (req.app.get('io')) {
    req.app.get('io').emit('newPrediction', result.rows[0]);
  }

  res.status(201).json(result.rows[0]);
});

// Create a new event
exports.createEvent = asyncHandler(async (req, res) => {
  const { title, details, closing_date, domain, event_type, outcomes, numeric_buckets } = req.body;
  const normalizedDomain = matchConfig.normalizeDomain(domain);
  const normalizedEventType = normalizeEventType(event_type);
  const outcomeRows = normalizeOutcomeRows(normalizedEventType, outcomes, numeric_buckets);

  if ((normalizedEventType === 'multiple_choice' || normalizedEventType === 'numeric') && outcomeRows.length < 2) {
    return res.status(400).json({ message: `${normalizedEventType} events require at least two outcomes/buckets` });
  }
  if (normalizedEventType === 'numeric' && !validateNumericBuckets(outcomeRows)) {
    return res.status(400).json({ message: 'numeric buckets overlap or are invalid' });
  }

  const newEvent = await db.executeWithTransaction(async (client) => {
    let result;
    try {
      result = await client.query(
        "INSERT INTO events (title, details, closing_date, domain, event_type) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [title, details, closing_date, normalizedDomain, normalizedEventType]
      );
    } catch (insertErr) {
      if (insertErr.code === '42703') {
        try {
          result = await client.query(
            "INSERT INTO events (title, details, closing_date, event_type) VALUES ($1, $2, $3, $4) RETURNING *",
            [title, details, closing_date, normalizedEventType]
          );
        } catch (fallbackErr) {
          if (fallbackErr.code === '42703') {
            result = await client.query(
              "INSERT INTO events (title, details, closing_date) VALUES ($1, $2, $3) RETURNING *",
              [title, details, closing_date]
            );
          } else {
            throw fallbackErr;
          }
        }
      } else {
        throw insertErr;
      }
    }

    const createdEvent = result.rows[0];
    await seedEventOutcomes(client, createdEvent.id, normalizedEventType, outcomeRows);
    return createdEvent;
  });

  setEventEmbedding({
    eventId: newEvent.id,
    title: newEvent.title,
    details: newEvent.details
  }).catch((error) => {
    console.error('[Event Embedding] Failed to create embedding:', error.message || error);
  });
  res.status(201).json(newEvent);
});

exports.setEventOutcomes = asyncHandler(async (req, res) => {
  const eventId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ message: 'Invalid event id' });
  }

  const { event_type, outcomes, numeric_buckets } = req.body;
  const normalizedEventType = normalizeEventType(event_type);
  if (normalizedEventType !== 'multiple_choice' && normalizedEventType !== 'numeric') {
    return res.status(400).json({ message: 'event_type must be multiple_choice or numeric' });
  }

  const outcomeRows = normalizeOutcomeRows(normalizedEventType, outcomes, numeric_buckets);
  if (outcomeRows.length < 2) {
    return res.status(400).json({ message: 'At least two outcomes/buckets required' });
  }
  if (normalizedEventType === 'numeric' && !validateNumericBuckets(outcomeRows)) {
    return res.status(400).json({ message: 'numeric buckets overlap or are invalid' });
  }

  const result = await db.executeWithTransaction(async (client) => {
    const eventRow = await client.query(
      'SELECT id, outcome FROM events WHERE id = $1 FOR UPDATE',
      [eventId]
    );
    if (eventRow.rows.length === 0) {
      const error = new Error('Event not found');
      error.status = 404;
      throw error;
    }
    if (eventRow.rows[0].outcome) {
      const error = new Error('Cannot reconfigure resolved event');
      error.status = 400;
      throw error;
    }

    const openPositions = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM user_shares WHERE event_id = $1 AND (yes_shares > 0 OR no_shares > 0)) AS binary_positions,
         (SELECT COUNT(*) FROM user_outcome_shares WHERE event_id = $1 AND shares > 0) AS outcome_positions`,
      [eventId]
    );
    const binaryPositions = Number(openPositions.rows[0].binary_positions || 0);
    const outcomePositions = Number(openPositions.rows[0].outcome_positions || 0);
    if (binaryPositions > 0 || outcomePositions > 0) {
      const error = new Error('Cannot reconfigure outcomes while positions are open');
      error.status = 409;
      throw error;
    }

    await client.query('DELETE FROM event_outcome_states WHERE event_id = $1', [eventId]);
    await client.query('DELETE FROM event_outcomes WHERE event_id = $1', [eventId]);
    await seedEventOutcomes(client, eventId, normalizedEventType, outcomeRows);

    const updated = await client.query(
      'UPDATE events SET event_type = $1, resolution_outcome_id = NULL, updated_at = NOW() WHERE id = $2 RETURNING id, event_type',
      [normalizedEventType, eventId]
    );
    return updated.rows[0];
  });

  return res.status(200).json({
    message: 'Event outcomes updated',
    event: result
  });
});

// Get all available events with optional search
exports.getEvents = asyncHandler(async (req, res) => {
  console.log('getEvents called');
  console.log('User ID:', req.user ? req.user.userId : 'No auth required');

  // Get search parameter if provided
  const search = req.query.search;
  // Keep response lean for UI. Exclude heavyweight internal search fields
  // (embedding/search_vector) which are not needed on predictions pages.
  let query = `
    SELECT
      id,
      topic_id,
      title,
      details,
      closing_date,
      outcome,
      created_at,
      updated_at,
      category,
      event_type,
      numerical_outcome,
      market_prob,
      liquidity_b,
      cumulative_stake,
      q_yes,
      q_no,
      domain
    FROM events
    WHERE 1=1
  `;
  let params = [];

  // Add search functionality
  if (search && search.trim()) {
    query += " AND title ILIKE $1";
    params.push(`%${search.trim()}%`);
  }

  // Order by closing date, but show events even if closing date has passed (for Metaculus questions)
  query += " ORDER BY closing_date ASC NULLS LAST";

  const result = await db.query(query, params);
  console.log('Events result:', result.rows.length, 'events found');

  res.status(200).json(result.rows);
});

exports.getEventById = asyncHandler(async (req, res) => {
  const eventId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ message: 'Invalid event id' });
  }

  const result = await db.query(
    `
      SELECT
        id,
        topic_id,
        title,
        details,
        closing_date,
        outcome,
        created_at,
        updated_at,
        category,
        event_type,
        numerical_outcome,
        market_prob,
        liquidity_b,
        cumulative_stake,
        q_yes,
        q_no,
        domain
      FROM events
      WHERE id = $1
      LIMIT 1
    `,
    [eventId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ message: 'Event not found' });
  }

  res.status(200).json(result.rows[0]);
});

// Resolve a prediction (admin only)
exports.resolvePrediction = asyncHandler(async (req, res) => {
  const { outcome } = req.body; // Should be "correct" or "incorrect"
  const { id } = req.params;
  const userId = req.user.userId;

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

  const prediction = result.rows[0];

  res.status(200).json(result.rows[0]);
});

exports.resolveEvent = asyncHandler(async (req, res) => {
  const { outcome, outcome_id, numerical_outcome } = req.body;
  const { id } = req.params;
  const outcomeValue = normalizeMarketOutcome(outcome);
  const outcomeId = Number.isInteger(outcome_id) ? outcome_id : Number.parseInt(outcome_id, 10);
  const hasOutcomeId = Number.isInteger(outcomeId) && outcomeId > 0;
  const hasNumericalOutcome = Number.isFinite(Number(numerical_outcome));
  const numericalValue = hasNumericalOutcome ? Number(numerical_outcome) : null;
  const eventId = Number.parseInt(id, 10);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ message: 'Invalid event id' });
  }

  if (!hasOutcomeId && !hasNumericalOutcome && !outcomeValue) {
    return res.status(400).json({ message: "Provide one of: outcome ('yes'/'no'), outcome_id, or numerical_outcome" });
  }

  const existingEvent = await db.query('SELECT id, outcome, event_type FROM events WHERE id = $1', [eventId]);
  if (existingEvent.rows.length === 0) {
    return res.status(404).json({ message: 'Event not found' });
  }
  if (existingEvent.rows[0].outcome) {
    return res.status(409).json({ message: 'Event already resolved' });
  }

  const resolvedBoolean = outcomeValue === 'yes';
  const engineBody = hasOutcomeId
    ? { outcome_id: outcomeId }
    : (hasNumericalOutcome ? { numerical_outcome: numericalValue } : { outcome: resolvedBoolean });
  const outcomeResponse = await fetch(`http://prediction-engine:3001/events/${eventId}/market-resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.PREDICTION_ENGINE_AUTH_TOKEN ? { 'x-engine-token': process.env.PREDICTION_ENGINE_AUTH_TOKEN } : {})
    },
    body: JSON.stringify(engineBody)
  });

  const outcomeResult = await outcomeResponse.json().catch(() => ({}));
  if (!outcomeResponse.ok) {
    return res.status(outcomeResponse.status).json(outcomeResult);
  }

  const backendOutcome = hasOutcomeId
    ? `resolved_outcome_${outcomeId}`
    : (hasNumericalOutcome ? 'resolved_numeric' : outcomeValue);
  const backendNumericalOutcome = hasNumericalOutcome
    ? numericalValue
    : (hasOutcomeId ? null : (resolvedBoolean ? 1 : 0));
  const resolvedOutcomeId = hasOutcomeId
    ? outcomeId
    : (Number.isInteger(outcomeResult.outcome_id) ? outcomeResult.outcome_id : null);

  const update = await db.query(
    `UPDATE events
     SET outcome = $1,
         numerical_outcome = $2,
         resolution_outcome_id = $3,
         updated_at = NOW()
     WHERE id = $4
     RETURNING id, title, outcome, numerical_outcome, resolution_outcome_id, closing_date`,
    [backendOutcome, backendNumericalOutcome, resolvedOutcomeId, eventId]
  );

  const resolvedEvent = update.rows[0];
  if (req.app.get('io')) {
    req.app.get('io').to('predictions').emit('marketResolved', {
      eventId,
      outcome: backendOutcome,
      outcome_id: resolvedOutcomeId,
      numerical_outcome: backendNumericalOutcome,
      timestamp: new Date().toISOString()
    });
  }

  return res.status(200).json({
    event: resolvedEvent,
    message: outcomeResult.message || `Market ${eventId} resolved`
  });
});

// Get assigned predictions for current user
exports.getAssignedPredictions = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

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
});

// Place a bet on an assigned prediction
exports.placeBet = asyncHandler(async (req, res) => {
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
    await db.query("ROLLBACK");
    throw err;
  }
});

// Get betting statistics for the current month
exports.getMonthlyBettingStats = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

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
});

// Assign a prediction to a specific user (Admin only)
exports.assignPredictions = asyncHandler(async (req, res) => {
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
    await db.query("ROLLBACK");
    throw err;
  }
});

// ADMIN: Delete all predictions (for testing only)
exports.deleteAllPredictions = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  // Check if the user is an admin
  const adminCheck = await db.query("SELECT role FROM users WHERE id = $1", [userId]);
  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== "admin") {
    return res.status(403).json({ message: "Only admins can delete all predictions." });
  }
  await db.query("DELETE FROM predictions");
  res.status(200).json({ message: "All predictions deleted." });
});

// Get all available categories from events
exports.getCategories = asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT DISTINCT category 
    FROM events 
    WHERE category IS NOT NULL 
    ORDER BY category ASC
  `);

  const categories = result.rows.map(row => row.category);
  res.status(200).json(categories);
});
