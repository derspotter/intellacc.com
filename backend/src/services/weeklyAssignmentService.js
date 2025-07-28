const db = require('../db');

class WeeklyAssignmentService {
  /**
   * Get current week in YYYY-WXX format
   */
  getCurrentWeek() {
    const now = new Date();
    const year = now.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((now - startOfYear) / (24 * 60 * 60 * 1000));
    const week = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-W${week.toString().padStart(2, '0')}`;
  }

  /**
   * Assign weekly predictions to all active users
   */
  async assignWeeklyPredictions() {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      const currentWeek = this.getCurrentWeek();
      console.log(`🗓️ Starting weekly assignment for week: ${currentWeek}`);
      
      // Get all users who don't have a weekly assignment for current week
      const usersResult = await client.query(`
        SELECT id, username 
        FROM users 
        WHERE (weekly_assignment_week != $1 OR weekly_assignment_week IS NULL)
        AND id IN (SELECT DISTINCT user_id FROM predictions)  -- Only active users
        ORDER BY id
      `, [currentWeek]);
      
      if (usersResult.rows.length === 0) {
        console.log('ℹ️ All users already have weekly assignments');
        await client.query('COMMIT');
        return { assigned: 0, message: 'All users already have weekly assignments' };
      }
      
      // Get available events for assignment (open events with closing date > 7 days from now)
      // Only include events that have market initialization (market_prob is not null)
      const eventsResult = await client.query(`
        SELECT e.id, e.title, e.closing_date, e.market_prob, COUNT(p.id) as prediction_count
        FROM events e
        LEFT JOIN predictions p ON e.id = p.event_id
        WHERE e.closing_date > NOW() + INTERVAL '7 days'
        AND e.outcome IS NULL
        AND e.market_prob IS NOT NULL  -- Only events with initialized markets
        GROUP BY e.id, e.title, e.closing_date, e.market_prob
        HAVING COUNT(p.id) < 50  -- Don't assign events with too many predictions
        ORDER BY COUNT(p.id) ASC, e.closing_date DESC
        LIMIT 20
      `);
      
      if (eventsResult.rows.length === 0) {
        console.log('⚠️ No suitable events available for assignment');
        await client.query('COMMIT');
        return { assigned: 0, message: 'No suitable events available' };
      }
      
      const availableEvents = eventsResult.rows;
      let assignmentCount = 0;
      
      // Assign one random event to each user
      for (const user of usersResult.rows) {
        // Pick a random event that the user hasn't predicted on yet
        const userPredictionsResult = await client.query(`
          SELECT event_id FROM predictions WHERE user_id = $1
        `, [user.id]);
        
        const userPredictedEvents = userPredictionsResult.rows.map(row => row.event_id);
        const availableForUser = availableEvents.filter(event => 
          !userPredictedEvents.includes(event.id)
        );
        
        if (availableForUser.length === 0) {
          console.log(`⚠️ No available events for user ${user.username}`);
          continue;
        }
        
        const randomEvent = availableForUser[Math.floor(Math.random() * availableForUser.length)];
        
        // Assign the event to the user (simple approach!)
        await client.query(`
          UPDATE users 
          SET weekly_assigned_event_id = $1,
              weekly_assignment_week = $2,
              weekly_assignment_completed = false,
              weekly_assignment_completed_at = NULL
          WHERE id = $3
        `, [randomEvent.id, currentWeek, user.id]);
        
        assignmentCount++;
        console.log(`✅ Assigned event "${randomEvent.title}" to user ${user.username}`);
      }
      
      await client.query('COMMIT');
      console.log(`🎯 Weekly assignment completed: ${assignmentCount} assignments created`);
      
      return { 
        assigned: assignmentCount, 
        week: currentWeek,
        message: `Successfully assigned weekly predictions to ${assignmentCount} users`
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error in weekly assignment:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Check and reward completed weekly assignments
   * Users must stake at least 1/4 Kelly optimal amount to get +50 RP reward
   */
  async processCompletedAssignments() {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      const currentWeek = this.getCurrentWeek();
      
      // Find users who completed their weekly assignment but haven't been rewarded
      const completedResult = await client.query(`
        SELECT 
          u.id, 
          u.username, 
          u.weekly_assigned_event_id, 
          u.weekly_assignment_week, 
          u.rp_balance,
          e.title as event_title,
          e.market_prob,
          p.prediction_value,
          p.confidence,
          mu.stake_amount
        FROM users u
        JOIN events e ON u.weekly_assigned_event_id = e.id
        JOIN predictions p ON u.id = p.user_id AND u.weekly_assigned_event_id = p.event_id
        LEFT JOIN market_updates mu ON u.id = mu.user_id AND u.weekly_assigned_event_id = mu.event_id
        WHERE u.weekly_assignment_week = $1
        AND u.weekly_assignment_completed = false
        AND p.prediction_value != 'pending'
        AND p.confidence IS NOT NULL
      `, [currentWeek]);
      
      let rewardCount = 0;
      let skipCount = 0;
      const rewardAmount = 50.0;
      let totalRewards = 0;
      
      for (const user of completedResult.rows) {
        // Calculate Kelly optimal amount for this user's belief
        const belief = parseFloat(user.confidence) / 100.0; // Convert percentage to decimal
        const marketProb = parseFloat(user.market_prob);
        const balance = parseFloat(user.rp_balance);
        
        // Kelly edge calculation
        const edge = belief > marketProb 
          ? (belief - marketProb) / (1 - marketProb)
          : (marketProb - belief) / marketProb;
        
        // Conservative Kelly (25% of full Kelly)
        const kellyFraction = 0.25;
        const kellyOptimal = edge * balance * kellyFraction;
        const quarterKelly = kellyOptimal / 4.0; // 1/4 of Kelly optimal
        
        // Check if user staked at least 1/4 Kelly optimal
        const userStake = user.stake_amount ? parseFloat(user.stake_amount) : 0;
        
        if (userStake >= quarterKelly && quarterKelly > 0) {
          // User staked enough - award the bonus
          await client.query(`
            UPDATE users 
            SET weekly_assignment_completed = true,
                weekly_assignment_completed_at = NOW(),
                rp_balance = rp_balance + $1
            WHERE id = $2
          `, [rewardAmount, user.id]);
          
          rewardCount++;
          totalRewards += rewardAmount;
          
          console.log(`💰 Rewarded ${user.username} with ${rewardAmount} RP for staking ${userStake} RP (≥${quarterKelly.toFixed(2)} required) on "${user.event_title}"`);
        } else {
          // User didn't stake enough - mark as completed but no reward
          await client.query(`
            UPDATE users 
            SET weekly_assignment_completed = true,
                weekly_assignment_completed_at = NOW()
            WHERE id = $1
          `, [user.id]);
          
          skipCount++;
          console.log(`⚠️ ${user.username} completed "${user.event_title}" but only staked ${userStake} RP (needed ${quarterKelly.toFixed(2)}) - no reward`);
        }
      }
      
      await client.query('COMMIT');
      
      return {
        rewarded: rewardCount,
        skipped: skipCount,
        totalRewards,
        week: currentWeek,
        message: `Rewarded ${rewardCount} users, skipped ${skipCount} users (insufficient stake) - ${totalRewards} total RP awarded`
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error processing completed assignments:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Apply 1% weekly decay to all RP balances
   */
  async applyWeeklyDecay() {
    const client = await db.getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      const currentWeek = this.getCurrentWeek();
      
      // Check if decay already applied for this week
      const existingDecay = await client.query(`
        SELECT COUNT(*) FROM weekly_decay_log WHERE week_year = $1
      `, [currentWeek]);
      
      if (existingDecay.rows[0].count > 0) {
        console.log(`⚠️ Weekly decay already applied for ${currentWeek}`);
        await client.query('COMMIT');
        return { processed: 0, message: `Decay already applied for ${currentWeek}` };
      }
      
      // Get all users with RP balance > 100 (minimum threshold)
      const usersResult = await client.query(`
        SELECT id, username, rp_balance 
        FROM users 
        WHERE rp_balance > 100.0
        ORDER BY id
      `);
      
      let processedCount = 0;
      let totalDecayAmount = 0;
      
      for (const user of usersResult.rows) {
        const originalBalance = parseFloat(user.rp_balance);
        const decayAmount = originalBalance * 0.01; // 1% decay
        const newBalance = originalBalance - decayAmount;
        
        // Apply decay
        await client.query(`
          UPDATE users 
          SET rp_balance = $1
          WHERE id = $2
        `, [newBalance.toFixed(2), user.id]);
        
        // Log the decay
        await client.query(`
          INSERT INTO weekly_decay_log 
          (user_id, week_year, rp_before_decay, decay_amount, rp_after_decay)
          VALUES ($1, $2, $3, $4, $5)
        `, [user.id, currentWeek, originalBalance, decayAmount, newBalance]);
        
        processedCount++;
        totalDecayAmount += decayAmount;
        
        console.log(`📉 Applied 1% decay to ${user.username}: ${originalBalance.toFixed(2)} → ${newBalance.toFixed(2)} RP`);
      }
      
      await client.query('COMMIT');
      
      console.log(`💸 Weekly decay completed: ${processedCount} users, ${totalDecayAmount.toFixed(2)} total RP decayed`);
      
      return {
        processed: processedCount,
        totalDecayAmount: totalDecayAmount.toFixed(2),
        week: currentWeek,
        message: `Applied 1% decay to ${processedCount} users`
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error applying weekly decay:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Update weekly assignment statistics
   */
  async updateWeeklyStats(client, weekYear) {
    const statsResult = await client.query(`
      SELECT 
        COUNT(DISTINCT user_id) as total_users,
        COUNT(*) as total_assignments,
        COUNT(CASE WHEN completed = true THEN 1 END) as completed_assignments,
        SUM(CASE WHEN completed = true THEN rp_reward ELSE 0 END) as total_rewards_paid
      FROM assigned_predictions
      WHERE week_year = $1
    `, [weekYear]);
    
    const stats = statsResult.rows[0];
    const completionRate = stats.total_assignments > 0 
      ? (stats.completed_assignments / stats.total_assignments * 100) 
      : 0;
    
    await client.query(`
      INSERT INTO weekly_assignment_stats 
      (week_year, total_users, total_assignments, completed_assignments, completion_rate, total_rewards_paid)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (week_year)
      DO UPDATE SET
        total_users = EXCLUDED.total_users,
        total_assignments = EXCLUDED.total_assignments,
        completed_assignments = EXCLUDED.completed_assignments,
        completion_rate = EXCLUDED.completion_rate,
        total_rewards_paid = EXCLUDED.total_rewards_paid
    `, [
      weekYear, 
      stats.total_users, 
      stats.total_assignments, 
      stats.completed_assignments, 
      completionRate.toFixed(2),
      stats.total_rewards_paid || 0
    ]);
  }
  
  /**
   * Get weekly assignment statistics
   */
  async getWeeklyStats(weekYear = null) {
    const client = await db.getPool().connect();
    
    try {
      const week = weekYear || this.getCurrentWeek();
      
      const result = await client.query(`
        SELECT * FROM weekly_assignment_stats 
        WHERE week_year = $1
      `, [week]);
      
      if (result.rows.length === 0) {
        return {
          week_year: week,
          total_users: 0,
          total_assignments: 0,
          completed_assignments: 0,
          completion_rate: 0,
          total_rewards_paid: 0
        };
      }
      
      return result.rows[0];
      
    } finally {
      client.release();
    }
  }
  
  /**
   * Get user's current week assignment status
   */
  async getUserWeeklyStatus(userId) {
    const client = await db.getPool().connect();
    
    try {
      const currentWeek = this.getCurrentWeek();
      
      const result = await client.query(`
        SELECT 
          u.weekly_assigned_event_id,
          u.weekly_assignment_week,
          u.weekly_assignment_completed,
          u.weekly_assignment_completed_at,
          e.title as event_title,
          e.closing_date,
          p.prediction_value,
          p.confidence,
          p.outcome,
          CASE 
            WHEN p.id IS NOT NULL THEN true 
            ELSE false 
          END as has_prediction
        FROM users u
        LEFT JOIN events e ON u.weekly_assigned_event_id = e.id
        LEFT JOIN predictions p ON u.id = p.user_id AND u.weekly_assigned_event_id = p.event_id
        WHERE u.id = $1 AND u.weekly_assignment_week = $2
      `, [userId, currentWeek]);
      
      return result.rows.length > 0 ? result.rows[0] : null;
      
    } finally {
      client.release();
    }
  }
}

module.exports = new WeeklyAssignmentService();