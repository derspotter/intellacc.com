const db = require('../db');

const LEDGER_SCALE = 1_000_000n;
const WEEKLY_REQUIREMENT_DIVISOR = 100n; // 1%
const RP_FLOOR_LEDGER = 100n * LEDGER_SCALE; // 100 RP floor

const formatLedgerToRp2 = (ledgerValue) => {
  const negative = ledgerValue < 0n;
  const abs = negative ? -ledgerValue : ledgerValue;
  const cents = (abs + 5_000n) / 10_000n;
  const whole = cents / 100n;
  const frac = cents % 100n;
  return `${negative ? '-' : ''}${whole.toString()}.${frac.toString().padStart(2, '0')}`;
};

class WeeklyAssignmentService {
  /**
   * Get current week in YYYY-WXX format
   */
  async getCurrentWeek(client = null) {
    try {
      const runner = client || db;
      const result = await runner.query('SELECT get_current_week() AS week');
      return result.rows[0]?.week;
    } catch (error) {
      console.warn('Failed to fetch current week from DB, using JS fallback:', error.message);
      return this.getCurrentWeekFallback(new Date());
    }
  }

  /**
   * Get previous week in YYYY-WXX format
   */
  async getPreviousWeek(client = null) {
    try {
      const runner = client || db;
      const result = await runner.query('SELECT get_previous_week() AS week');
      return result.rows[0]?.week;
    } catch (error) {
      console.warn('Failed to fetch previous week from DB, using JS fallback:', error.message);
      const prev = new Date();
      prev.setDate(prev.getDate() - 7);
      return this.getCurrentWeekFallback(prev);
    }
  }

  getCurrentWeekFallback(date) {
    // ISO week number fallback
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
    const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
    const year = target.getUTCFullYear();
    return `${year}-W${week.toString().padStart(2, '0')}`;
  }

  /**
   * Assign weekly predictions to all active users
   */
  async assignWeeklyPredictions() {
    const client = await db.getPool().connect();

    try {
      await client.query('BEGIN');

      const currentWeek = await this.getCurrentWeek(client);
      console.log(`🗓️ Starting weekly assignment for week: ${currentWeek}`);

      // Get all users who don't have a weekly assignment for current week
      const usersResult = await client.query(`
        SELECT id, username, rp_balance_ledger
        FROM users
        WHERE (weekly_assignment_week != $1 OR weekly_assignment_week IS NULL)
        AND id IN (SELECT DISTINCT user_id FROM market_updates)  -- Only active traders
        AND deleted_at IS NULL
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

        const userPredictedEvents = userPredictionsResult.rows.map((row) => row.event_id);
        const availableForUser = availableEvents.filter((event) =>
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

        const balanceLedger = BigInt(user.rp_balance_ledger || 0);
        const requiredStakeLedger = balanceLedger / WEEKLY_REQUIREMENT_DIVISOR;

        // Persist immutable assignment state keyed by (user, week) so decay/completion still work after rollover.
        await client.query(`
          INSERT INTO weekly_user_assignments
            (user_id, week_year, event_id, required_stake_ledger, completed, completed_at, penalty_applied, penalty_amount_ledger)
          VALUES ($1, $2, $3, $4, false, NULL, false, 0)
          ON CONFLICT (user_id, week_year)
          DO UPDATE SET
            event_id = EXCLUDED.event_id,
            required_stake_ledger = EXCLUDED.required_stake_ledger,
            completed = false,
            completed_at = NULL,
            penalty_applied = false,
            penalty_amount_ledger = 0,
            updated_at = NOW()
        `, [user.id, currentWeek, randomEvent.id, requiredStakeLedger.toString()]);

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
   * Mark completed weekly assignments
   * Weekly requirement: stake at least 1% of current RP balance
   */
  async processCompletedAssignments() {
    const client = await db.getPool().connect();

    try {
      await client.query('BEGIN');

      const previousWeek = await this.getPreviousWeek(client);

      // Evaluate completion from immutable per-week assignments, not mutable users.weekly_* fields.
      const completedResult = await client.query(`
        SELECT
          wua.user_id AS id,
          u.username,
          wua.event_id AS weekly_assigned_event_id,
          wua.week_year AS weekly_assignment_week,
          u.rp_balance_ledger,
          wua.required_stake_ledger,
          e.title as event_title,
          COALESCE(SUM(mu.stake_amount_ledger), 0) as stake_amount_ledger,
          COALESCE(SUM(mu.stake_amount), 0) as stake_amount,
          MAX(mu.created_at) as last_stake_at
        FROM weekly_user_assignments wua
        JOIN users u ON u.id = wua.user_id
        LEFT JOIN events e ON e.id = wua.event_id
        LEFT JOIN market_updates mu
          ON wua.user_id = mu.user_id
          AND wua.event_id = mu.event_id
          AND mu.created_at >= date_trunc('week', NOW() - INTERVAL '1 week')
          AND mu.created_at < date_trunc('week', NOW())
        WHERE wua.week_year = $1
        AND wua.event_id IS NOT NULL
        AND wua.completed = false
        AND u.deleted_at IS NULL
        GROUP BY wua.user_id, u.username, wua.event_id, wua.week_year, u.rp_balance_ledger, wua.required_stake_ledger, e.title
      `, [previousWeek]);

      let completedCount = 0;
      let incompleteCount = 0;

      for (const user of completedResult.rows) {
        const balanceLedger = BigInt(user.rp_balance_ledger || 0);
        const fallbackRequirement = balanceLedger / WEEKLY_REQUIREMENT_DIVISOR;
        const requiredStakeLedger = user.required_stake_ledger !== null
          ? BigInt(user.required_stake_ledger)
          : fallbackRequirement;
        const stakeLedger = BigInt(user.stake_amount_ledger || 0);
        const stakeAmountRp = formatLedgerToRp2(stakeLedger);
        const requiredStakeRp = formatLedgerToRp2(requiredStakeLedger);

        if (stakeLedger >= requiredStakeLedger) {
          await client.query(`
            UPDATE weekly_user_assignments
            SET completed = true,
                completed_at = NOW(),
                updated_at = NOW()
            WHERE user_id = $1 AND week_year = $2
          `, [user.id, previousWeek]);

          // Keep users.weekly_* in sync for UI, but only if user row still points to this same week.
          await client.query(`
            UPDATE users
            SET weekly_assignment_completed = true,
                weekly_assignment_completed_at = NOW()
            WHERE id = $1
              AND weekly_assignment_week = $2
          `, [user.id, previousWeek]);

          completedCount++;

          console.log(
            `✅ Marked ${user.username} complete for "${user.event_title}" ` +
            `(staked ${stakeAmountRp} RP, required ${requiredStakeRp} RP)`
          );
        } else {
          incompleteCount++;
          console.log(
            `⚠️ ${user.username} incomplete for "${user.event_title}" ` +
            `(staked ${stakeAmountRp} RP, required ${requiredStakeRp} RP)`
          );
        }
      }

      await client.query('COMMIT');

      return {
        completed: completedCount,
        incomplete: incompleteCount,
        week: previousWeek,
        message: `Marked ${completedCount} users complete and ${incompleteCount} users incomplete`
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
   * Apply 1% missed-week penalty with 100 RP floor
   */
  async applyWeeklyDecay() {
    const client = await db.getPool().connect();

    try {
      await client.query('BEGIN');

      const previousWeek = await this.getPreviousWeek(client);

      // Penalize users who missed last week's immutable assignment and haven't been processed yet.
      const usersResult = await client.query(`
        SELECT u.id, u.username, u.rp_balance_ledger
        FROM weekly_user_assignments wua
        JOIN users u ON u.id = wua.user_id
        WHERE wua.week_year = $1
          AND wua.completed = false
          AND wua.penalty_applied = false
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM weekly_decay_log wdl
            WHERE wdl.user_id = wua.user_id
              AND wdl.week_year = wua.week_year
          )
        ORDER BY u.id
      `, [previousWeek]);

      let processedCount = 0;
      let totalDecayLedger = 0n;

      for (const user of usersResult.rows) {
        const originalBalanceLedger = BigInt(user.rp_balance_ledger);
        let decayLedger = originalBalanceLedger / WEEKLY_REQUIREMENT_DIVISOR; // 1% penalty
        let newBalanceLedger = originalBalanceLedger - decayLedger;

        if (newBalanceLedger < RP_FLOOR_LEDGER) {
          decayLedger = originalBalanceLedger - RP_FLOOR_LEDGER;
          newBalanceLedger = RP_FLOOR_LEDGER;
        }

        if (decayLedger <= 0n) {
          await client.query(`
            UPDATE weekly_user_assignments
            SET penalty_applied = true,
                penalty_amount_ledger = 0,
                updated_at = NOW()
            WHERE user_id = $1 AND week_year = $2
          `, [user.id, previousWeek]);
          continue;
        }

        const originalBalance = formatLedgerToRp2(originalBalanceLedger);
        const decayAmount = formatLedgerToRp2(decayLedger);
        const newBalance = formatLedgerToRp2(newBalanceLedger);

        // Apply penalty
        await client.query(`
          UPDATE users
          SET rp_balance_ledger = $1
          WHERE id = $2
        `, [newBalanceLedger.toString(), user.id]);

        // Log the decay (idempotent)
        await client.query(`
          INSERT INTO weekly_decay_log
          (user_id, week_year, rp_before_decay, decay_amount, rp_after_decay)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (user_id, week_year) DO NOTHING
        `, [user.id, previousWeek, originalBalance, decayAmount, newBalance]);

        await client.query(`
          UPDATE weekly_user_assignments
          SET penalty_applied = true,
              penalty_amount_ledger = $1,
              updated_at = NOW()
          WHERE user_id = $2 AND week_year = $3
        `, [decayLedger.toString(), user.id, previousWeek]);

        processedCount++;
        totalDecayLedger += decayLedger;

        console.log(`📉 Applied 1% missed-week penalty to ${user.username}: ${originalBalance} → ${newBalance} RP`);
      }

      await client.query('COMMIT');

      const totalDecayAmount = formatLedgerToRp2(totalDecayLedger);
      console.log(`💸 Weekly missed-assignment penalty completed: ${processedCount} users, ${totalDecayAmount} total RP deducted`);

      return {
        processed: processedCount,
        totalDecayAmount,
        week: previousWeek,
        message: `Applied 1% missed-week penalty to ${processedCount} users`
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
      const week = weekYear || await this.getCurrentWeek(client);

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
      const currentWeek = await this.getCurrentWeek(client);

      const result = await client.query(`
        SELECT
          COALESCE(wua.event_id, u.weekly_assigned_event_id) AS event_id,
          COALESCE(wua.week_year, u.weekly_assignment_week) AS weekly_assignment_week,
          COALESCE(wua.completed, u.weekly_assignment_completed) AS weekly_assignment_completed,
          COALESCE(wua.completed_at, u.weekly_assignment_completed_at) AS weekly_assignment_completed_at,
          COALESCE(wua.required_stake_ledger, u.rp_balance_ledger / 100) AS required_stake_ledger,
          u.rp_balance_ledger,
          e.title as event_title,
          e.closing_date,
          COALESCE(SUM(mu.stake_amount), 0) as stake_amount,
          COALESCE(SUM(mu.stake_amount_ledger), 0) as stake_amount_ledger,
          MAX(mu.created_at) as last_stake_at,
          CASE
            WHEN COALESCE(SUM(mu.stake_amount_ledger), 0) > 0 THEN true
            ELSE false
          END as has_stake
        FROM users u
        LEFT JOIN weekly_user_assignments wua
          ON wua.user_id = u.id
          AND wua.week_year = $2
        LEFT JOIN events e ON COALESCE(wua.event_id, u.weekly_assigned_event_id) = e.id
        LEFT JOIN market_updates mu
          ON u.id = mu.user_id
          AND COALESCE(wua.event_id, u.weekly_assigned_event_id) = mu.event_id
          AND mu.created_at >= date_trunc('week', NOW())
          AND mu.created_at < date_trunc('week', NOW()) + INTERVAL '1 week'
        WHERE u.id = $1
          AND (wua.week_year IS NOT NULL OR u.weekly_assignment_week = $2)
        GROUP BY
          COALESCE(wua.event_id, u.weekly_assigned_event_id),
          COALESCE(wua.week_year, u.weekly_assignment_week),
          COALESCE(wua.completed, u.weekly_assignment_completed),
          COALESCE(wua.completed_at, u.weekly_assignment_completed_at),
          COALESCE(wua.required_stake_ledger, u.rp_balance_ledger / 100),
          u.rp_balance_ledger,
          e.title,
          e.closing_date
      `, [userId, currentWeek]);

      if (result.rows.length === 0) {
        return null;
      }

      const assignment = result.rows[0];
      const balanceLedger = BigInt(assignment.rp_balance_ledger || 0);
      const stakeLedger = BigInt(assignment.stake_amount_ledger || 0);
      const fallbackRequirement = balanceLedger / WEEKLY_REQUIREMENT_DIVISOR;
      const requiredStakeLedger = assignment.required_stake_ledger !== null
        ? BigInt(assignment.required_stake_ledger)
        : fallbackRequirement;

      return {
        ...assignment,
        stake_amount_ledger: stakeLedger.toString(),
        has_prediction: assignment.has_stake, // Back-compat for UI
        min_stake_rp: formatLedgerToRp2(requiredStakeLedger)
      };

    } finally {
      client.release();
    }
  }
}

module.exports = new WeeklyAssignmentService();
