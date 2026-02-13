const db = require('../db');
const { runAutomaticMarketQuestionRewards } = require('./marketQuestionController');
const weeklyAssignmentService = require('../services/weeklyAssignmentService');

/**
 * Manually trigger weekly assignment process (admin only)
 */
const assignWeeklyPredictions = async (req, res) => {
  try {
    // TODO: Add admin authentication check
    console.log('🗓️ Manual weekly assignment triggered');
    
    const result = await weeklyAssignmentService.assignWeeklyPredictions();
    
    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error in weekly assignment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to assign weekly predictions',
      details: error.message
    });
  }
};

/**
 * Process completed weekly assignments (admin only)
 */
const processCompletedAssignments = async (req, res) => {
  try {
    console.log('✅ Processing completed weekly assignments');
    
    const result = await weeklyAssignmentService.processCompletedAssignments();
    
    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error processing completed assignments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process completed assignments',
      details: error.message
    });
  }
};

/**
 * Apply weekly missed-assignment penalty (admin only)
 */
const applyWeeklyDecay = async (req, res) => {
  try {
    console.log('📉 Applying weekly missed-assignment penalty');
    
    const result = await weeklyAssignmentService.applyWeeklyDecay();
    
    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error applying weekly decay:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to apply weekly decay',
      details: error.message
    });
  }
};

/**
 * Get weekly assignment statistics
 */
const getWeeklyStats = async (req, res) => {
  try {
    const { week } = req.query;
    
    const stats = await weeklyAssignmentService.getWeeklyStats(week);
    
    res.status(200).json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting weekly stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get weekly statistics',
      details: error.message
    });
  }
};

/**
 * Get user's current weekly assignment status
 */
const getUserWeeklyStatus = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID'
      });
    }

    const requester = req.user;
    if (!requester) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const isAdmin = requester.role === 'admin';
    if (!isAdmin && requester.id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
    }
    
    const status = await weeklyAssignmentService.getUserWeeklyStatus(userId);
    
    res.status(200).json({
      success: true,
      assignment: status,
      hasAssignment: !!status,
      isCompleted: status ? status.completed : false
    });
  } catch (error) {
    console.error('Error getting user weekly status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user weekly status',
      details: error.message
    });
  }
};

/**
 * Run all weekly processes (completion processing, missed-week penalty, new assignments) - admin only
 */
const runWeeklyProcesses = async (req, res) => {
  try {
    console.log('🔄 Running all weekly processes');
    
    // 1. Process completed assignments from previous week
    const completedResult = await weeklyAssignmentService.processCompletedAssignments();
    
    // 2. Apply missed-week penalty
    const decayResult = await weeklyAssignmentService.applyWeeklyDecay();
    
    // 3. Assign new weekly predictions
    const assignmentResult = await weeklyAssignmentService.assignWeeklyPredictions();

    // 4. Auto-issue market-question rewards (traction + resolution)
    const rewardsClient = await db.getPool().connect();
    let rewardResult = { success: true, traction_rewarded: 0, resolution_rewarded: 0, results: [] };
    try {
      await rewardsClient.query('BEGIN');
      rewardResult = await runAutomaticMarketQuestionRewards(rewardsClient);
      await rewardsClient.query('COMMIT');
    } catch (err) {
      await rewardsClient.query('ROLLBACK');
      throw err;
    } finally {
      rewardsClient.release();
    }
    
    res.status(200).json({
      success: true,
      message: 'All weekly processes completed successfully',
      results: {
        completed_assignments: completedResult,
        decay: decayResult,
        new_assignments: assignmentResult,
        market_question_rewards: rewardResult
      }
    });
  } catch (error) {
    console.error('Error running weekly processes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to run weekly processes',
      details: error.message
    });
  }
};

module.exports = {
  assignWeeklyPredictions,
  processCompletedAssignments,
  applyWeeklyDecay,
  getWeeklyStats,
  getUserWeeklyStatus,
  runWeeklyProcesses
};
