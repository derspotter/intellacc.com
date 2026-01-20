// backend/src/services/scoringService.js

const axios = require('axios');

const PREDICTION_ENGINE_URL = process.env.PREDICTION_ENGINE_URL || 'http://prediction-engine:3001';
const PREDICTION_ENGINE_AUTH_TOKEN = process.env.PREDICTION_ENGINE_AUTH_TOKEN;

// Create axios instance with default config
const predictionEngineClient = axios.create({
  baseURL: PREDICTION_ENGINE_URL,
  timeout: 30000, // 30 second timeout
  headers: {
    'Content-Type': 'application/json',
    ...(PREDICTION_ENGINE_AUTH_TOKEN ? { 'x-engine-token': PREDICTION_ENGINE_AUTH_TOKEN } : {})
  }
});

/**
 * Trigger score update for a user after they make a prediction
 * This runs in the background and doesn't block the response
 */
async function triggerScoreUpdate(userId) {
  try {
    // First calculate log scores for all predictions
    const calculateResponse = await predictionEngineClient.get('/log-scoring/calculate');
    console.log(`Calculated log scores: ${calculateResponse.data.updated_predictions} predictions updated`);

    // Then update time-weighted scores
    const timeWeightResponse = await predictionEngineClient.get('/log-scoring/time-weights');
    console.log(`Updated time-weighted scores for ${timeWeightResponse.data.updated_users} users`);

    // Finally update this specific user's reputation
    const reputationResponse = await predictionEngineClient.get(`/user/${userId}/update-reputation`);
    console.log(`Updated reputation for user ${userId}: ${reputationResponse.data.rep_points} points`);

    return {
      success: true,
      repPoints: reputationResponse.data.rep_points
    };
  } catch (error) {
    console.error('Error updating scores:', error.message);
    throw error;
  }
}

/**
 * Trigger score recalculation when an event is resolved
 * This affects all users who predicted on this event
 */
async function triggerEventResolutionScoring(eventId) {
  try {
    // Calculate log scores for all resolved predictions
    const calculateResponse = await predictionEngineClient.get('/log-scoring/calculate');
    console.log(`Recalculated scores after event ${eventId} resolution: ${calculateResponse.data.updated_predictions} predictions`);

    // Update time-weighted scores for all affected users
    const timeWeightResponse = await predictionEngineClient.get('/log-scoring/time-weights');
    console.log(`Updated time-weighted scores for ${timeWeightResponse.data.updated_users} users`);

    return {
      success: true,
      updatedPredictions: calculateResponse.data.updated_predictions,
      updatedUsers: timeWeightResponse.data.updated_users
    };
  } catch (error) {
    console.error('Error updating scores after event resolution:', error.message);
    throw error;
  }
}

/**
 * Get user's current reputation and scoring stats
 */
async function getUserReputation(userId) {
  try {
    const response = await predictionEngineClient.get(`/user/${userId}/reputation`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Get the unified log scoring leaderboard
 */
async function getLeaderboard(limit = 10) {
  try {
    const response = await predictionEngineClient.get(`/log-scoring/leaderboard?limit=${limit}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching leaderboard:', error.message);
    throw error;
  }
}

module.exports = {
  triggerScoreUpdate,
  triggerEventResolutionScoring,
  getUserReputation,
  getLeaderboard
};
