const db = require('../db');

// Get fast leaderboard from stored rankings (zero-sum relative ranking)
exports.getFastLeaderboard = async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  
  try {
    const result = await db.query(`
      SELECT 
        u.id as user_id,
        u.username,
        ur.rep_points,
        ur.global_rank,
        ur.time_weighted_score,
        COUNT(p.id) as total_predictions
      FROM users u
      JOIN user_reputation ur ON u.id = ur.user_id
      LEFT JOIN predictions p ON u.id = p.user_id AND p.raw_log_loss IS NOT NULL
      WHERE ur.global_rank IS NOT NULL
      GROUP BY u.id, u.username, ur.rep_points, ur.global_rank, ur.time_weighted_score
      ORDER BY ur.global_rank ASC
      LIMIT $1
    `, [limit]);

    res.json({
      leaderboard: result.rows,
      source: "stored_rankings",
      description: "Fast leaderboard from pre-calculated zero-sum rankings"
    });
  } catch (error) {
    console.error('Error getting fast leaderboard:', error);
    res.status(500).json({ message: 'Error fetching fast leaderboard' });
  }
};

// Get global leaderboard (all users)
exports.getGlobalLeaderboard = async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  
  try {
    const result = await db.query(`
      SELECT 
        u.id as user_id,
        u.username,
        (COALESCE(u.rp_balance_ledger, 1000000000)::DOUBLE PRECISION / 1000000.0) as rep_points,
        COALESCE(ur.time_weighted_score, 0.0) as time_weighted_score,
        COALESCE(ur.peer_bonus, 0.0) as peer_bonus,
        COUNT(p.id) as total_predictions,
        AVG(p.raw_log_loss) as avg_log_loss,
        ur.updated_at
      FROM users u
      LEFT JOIN user_reputation ur ON u.id = ur.user_id
      LEFT JOIN predictions p ON u.id = p.user_id AND p.raw_log_loss IS NOT NULL
      GROUP BY u.id, u.username, u.rp_balance_ledger, ur.time_weighted_score, ur.peer_bonus, ur.updated_at
      ORDER BY COALESCE(u.rp_balance_ledger, 1000000000) DESC, COUNT(p.id) DESC
      LIMIT $1
    `, [limit]);

    res.json({
      type: 'global',
      leaderboard: result.rows
    });
  } catch (error) {
    console.error('Error fetching global leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch global leaderboard' });
  }
};

// Get followers leaderboard (user + their followers)
exports.getFollowersLeaderboard = async (req, res) => {
  const userId = req.user.id;
  const limit = parseInt(req.query.limit) || 10;
  
  try {
    // First, get follower IDs
    const followersResult = await db.query(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [userId]
    );
    
    // Include current user + followers
    const userIds = [userId, ...followersResult.rows.map(row => row.follower_id)];
    
    // Get leaderboard filtered by these user IDs
    const result = await db.query(`
      SELECT 
        u.id as user_id,
        u.username,
        COALESCE(ur.rep_points, 1.0) as rep_points,
        COALESCE(ur.time_weighted_score, 0.0) as time_weighted_score,
        COALESCE(ur.peer_bonus, 0.0) as peer_bonus,
        COUNT(p.id) as total_predictions,
        AVG(p.raw_log_loss) as avg_log_loss,
        ur.updated_at,
        CASE WHEN u.id = $1 THEN true ELSE false END as is_current_user
      FROM users u
      LEFT JOIN user_reputation ur ON u.id = ur.user_id
      LEFT JOIN predictions p ON u.id = p.user_id AND p.raw_log_loss IS NOT NULL
      WHERE u.id = ANY($2)
      GROUP BY u.id, u.username, ur.rep_points, ur.time_weighted_score, ur.peer_bonus, ur.updated_at
      ORDER BY COALESCE(ur.rep_points, 1.0) DESC, COUNT(p.id) DESC
      LIMIT $3
    `, [userId, userIds, limit]);

    res.json({
      type: 'followers',
      leaderboard: result.rows
    });
  } catch (error) {
    console.error('Error fetching followers leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch followers leaderboard' });
  }
};

// Get following leaderboard (user + people they follow)
exports.getFollowingLeaderboard = async (req, res) => {
  const userId = req.user.id;
  const limit = parseInt(req.query.limit) || 10;
  
  try {
    // First, get following IDs
    const followingResult = await db.query(
      'SELECT following_id FROM follows WHERE follower_id = $1',
      [userId]
    );
    
    // Include current user + people they follow
    const userIds = [userId, ...followingResult.rows.map(row => row.following_id)];
    
    // Get leaderboard filtered by these user IDs
    const result = await db.query(`
      SELECT 
        u.id as user_id,
        u.username,
        COALESCE(ur.rep_points, 1.0) as rep_points,
        COALESCE(ur.time_weighted_score, 0.0) as time_weighted_score,
        COALESCE(ur.peer_bonus, 0.0) as peer_bonus,
        COUNT(p.id) as total_predictions,
        AVG(p.raw_log_loss) as avg_log_loss,
        ur.updated_at,
        CASE WHEN u.id = $1 THEN true ELSE false END as is_current_user
      FROM users u
      LEFT JOIN user_reputation ur ON u.id = ur.user_id
      LEFT JOIN predictions p ON u.id = p.user_id AND p.raw_log_loss IS NOT NULL
      WHERE u.id = ANY($2)
      GROUP BY u.id, u.username, ur.rep_points, ur.time_weighted_score, ur.peer_bonus, ur.updated_at
      ORDER BY COALESCE(ur.rep_points, 1.0) DESC, COUNT(p.id) DESC
      LIMIT $3
    `, [userId, userIds, limit]);

    res.json({
      type: 'following',
      leaderboard: result.rows
    });
  } catch (error) {
    console.error('Error fetching following leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch following leaderboard' });
  }
};

// Get network leaderboard (user + followers + following)
exports.getNetworkLeaderboard = async (req, res) => {
  const userId = req.user.id;
  const limit = parseInt(req.query.limit) || 10;
  
  try {
    // Get both followers and following IDs
    const [followersResult, followingResult] = await Promise.all([
      db.query('SELECT follower_id FROM follows WHERE following_id = $1', [userId]),
      db.query('SELECT following_id FROM follows WHERE follower_id = $1', [userId])
    ]);
    
    // Combine all user IDs (current user + followers + following), remove duplicates
    const allUserIds = new Set([
      userId,
      ...followersResult.rows.map(row => row.follower_id),
      ...followingResult.rows.map(row => row.following_id)
    ]);
    
    // Get leaderboard filtered by network user IDs
    const result = await db.query(`
      SELECT 
        u.id as user_id,
        u.username,
        COALESCE(ur.rep_points, 1.0) as rep_points,
        COALESCE(ur.time_weighted_score, 0.0) as time_weighted_score,
        COALESCE(ur.peer_bonus, 0.0) as peer_bonus,
        COUNT(p.id) as total_predictions,
        AVG(p.raw_log_loss) as avg_log_loss,
        ur.updated_at,
        CASE WHEN u.id = $1 THEN true ELSE false END as is_current_user
      FROM users u
      LEFT JOIN user_reputation ur ON u.id = ur.user_id
      LEFT JOIN predictions p ON u.id = p.user_id AND p.raw_log_loss IS NOT NULL
      WHERE u.id = ANY($2)
      GROUP BY u.id, u.username, ur.rep_points, ur.time_weighted_score, ur.peer_bonus, ur.updated_at
      ORDER BY COALESCE(ur.rep_points, 1.0) DESC, COUNT(p.id) DESC
      LIMIT $3
    `, [userId, Array.from(allUserIds), limit]);

    res.json({
      type: 'network',
      leaderboard: result.rows
    });
  } catch (error) {
    console.error('Error fetching network leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch network leaderboard' });
  }
};

// Get user's rank in global leaderboard
exports.getUserRank = async (req, res) => {
  const userId = req.user.id;
  
  try {
    const result = await db.query(`
      WITH ranked_users AS (
        SELECT 
          u.id,
          (COALESCE(u.rp_balance_ledger, 1000000000)::DOUBLE PRECISION / 1000000.0) as rep_points,
          COUNT(p.id) as total_predictions,
          ROW_NUMBER() OVER (ORDER BY COALESCE(u.rp_balance_ledger, 1000000000) DESC, COUNT(p.id) DESC) as rank
        FROM users u
        LEFT JOIN user_reputation ur ON u.id = ur.user_id
        LEFT JOIN predictions p ON u.id = p.user_id AND p.raw_log_loss IS NOT NULL
        GROUP BY u.id, u.rp_balance_ledger
      )
      SELECT rank, rep_points, total_predictions
      FROM ranked_users
      WHERE id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.json({
        user_id: userId,
        rank: null,
        rep_points: 1000.0,
        total_predictions: 0,
        message: 'User has no predictions yet'
      });
    }

    res.json({
      user_id: userId,
      ...result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching user rank:', error);
    res.status(500).json({ error: 'Failed to fetch user rank' });
  }
};
