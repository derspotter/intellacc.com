// backend/src/controllers/scoringController.js

const axios = require('axios');

// Configuration for prediction engine
const PREDICTION_ENGINE_URL = process.env.PREDICTION_ENGINE_URL || 'http://prediction-engine:3001';

// Helper function to make requests to prediction engine
async function forwardToPredictionEngine(path, method = 'GET', data = null) {
  try {
    const config = {
      method,
      url: `${PREDICTION_ENGINE_URL}${path}`,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    if (data) {
      config.data = data;
    }

    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(`Error forwarding to prediction engine: ${error.message}`);
    if (error.response) {
      throw {
        status: error.response.status,
        message: error.response.data?.error || error.message
      };
    }
    throw error;
  }
}

// Get user reputation stats
exports.getUserReputation = async (req, res) => {
  const { userId } = req.params;
  
  try {
    const data = await forwardToPredictionEngine(`/user/${userId}/reputation`);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to get user reputation' 
    });
  }
};

// Update user reputation
exports.updateUserReputation = async (req, res) => {
  const { userId } = req.params;
  
  try {
    const data = await forwardToPredictionEngine(`/user/${userId}/update-reputation`);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to update user reputation' 
    });
  }
};

// Get unified log scoring leaderboard
exports.getLogScoringLeaderboard = async (req, res) => {
  const limit = req.query.limit || 10;
  
  try {
    const data = await forwardToPredictionEngine(`/log-scoring/leaderboard?limit=${limit}`);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to get leaderboard' 
    });
  }
};

// Calculate log scores for all resolved predictions
exports.calculateLogScores = async (req, res) => {
  try {
    const data = await forwardToPredictionEngine('/log-scoring/calculate');
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to calculate log scores' 
    });
  }
};

// Calculate time-weighted scores
exports.calculateTimeWeights = async (req, res) => {
  try {
    const data = await forwardToPredictionEngine('/log-scoring/time-weights');
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to calculate time weights' 
    });
  }
};

// Get enhanced leaderboard with Brier scores
exports.getEnhancedLeaderboard = async (req, res) => {
  try {
    const data = await forwardToPredictionEngine('/enhanced-leaderboard');
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to get enhanced leaderboard' 
    });
  }
};

// Get user's enhanced accuracy with Brier scores
exports.getUserEnhancedAccuracy = async (req, res) => {
  const { userId } = req.params;
  
  try {
    const data = await forwardToPredictionEngine(`/user/${userId}/enhanced-accuracy`);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to get user accuracy' 
    });
  }
};

// Get user's calibration data
exports.getUserCalibration = async (req, res) => {
  const { userId } = req.params;
  
  try {
    const data = await forwardToPredictionEngine(`/user/${userId}/calibration`);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to get calibration data' 
    });
  }
};

// Get user's Brier score
exports.getUserBrierScore = async (req, res) => {
  const { userId } = req.params;
  
  try {
    const data = await forwardToPredictionEngine(`/user/${userId}/brier`);
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ 
      error: error.message || 'Failed to get Brier score' 
    });
  }
};