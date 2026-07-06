const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(20000);

// Verifies that trades on multi-outcome (multiple_choice/numeric) events, which journal into
// market_outcome_updates rather than market_updates, still count toward weekly assignment
// completion. Regression coverage for the completion queries in weeklyAssignmentService.js.

const cleanup = {
  users: new Set(),
  events: new Set(),
  eventOutcomes: new Set(),
  marketOutcomeUpdates: new Set()
};

const createUser = async ({ email, username, password, rpBalanceLedger = 0 }) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, updated_at, rp_balance_ledger)
     VALUES ($1, $2, $3, NOW(), NOW(), $4)
     RETURNING id`,
    [email, username, passwordHash, rpBalanceLedger]
  );
  const id = result.rows[0].id;
  cleanup.users.add(id);
  return id;
};

const createMultipleChoiceEvent = async ({ title, closingDate }) => {
  const result = await db.query(
    `INSERT INTO events
       (title, closing_date, created_at, updated_at, market_prob, liquidity_b, cumulative_stake, q_yes, q_no, event_type)
     VALUES ($1, $2, NOW(), NOW(), 0.5, 5000, 0, 0, 0, 'multiple_choice')
     RETURNING id`,
    [title, closingDate]
  );
  const id = result.rows[0].id;
  cleanup.events.add(id);
  return id;
};

const createOutcome = async ({ eventId, outcomeKey, label, sortOrder = 0 }) => {
  const result = await db.query(
    `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [eventId, outcomeKey, label, sortOrder]
  );
  const id = result.rows[0].id;
  cleanup.eventOutcomes.add(id);
  return id;
};

const insertMarketOutcomeUpdate = async ({ userId, eventId, outcomeId, stakeAmount, createdAt }) => {
  const prevProb = 0.5;
  const newProb = 0.5001;
  const sharesAcquired = 1;
  const holdUntil = new Date(Date.now() + 60 * 60 * 1000);
  const stakeLedger = Math.round(stakeAmount * 1_000_000);

  const result = await db.query(
    `INSERT INTO market_outcome_updates
       (user_id, event_id, outcome_id, prev_prob, new_prob, stake_amount, stake_amount_ledger, shares_acquired, hold_until, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [userId, eventId, outcomeId, prevProb, newProb, stakeAmount, stakeLedger, sharesAcquired, holdUntil, createdAt]
  );
  cleanup.marketOutcomeUpdates.add(result.rows[0].id);
  return result.rows[0].id;
};

const upsertWeeklyAssignment = async ({
  userId,
  weekYear,
  eventId,
  requiredStakeLedger,
  completed = false
}) => {
  await db.query(
    `INSERT INTO weekly_user_assignments
      (user_id, week_year, event_id, required_stake_ledger, completed, completed_at, penalty_applied, penalty_amount_ledger)
     VALUES ($1, $2, $3, $4, $5, NULL, false, 0)
     ON CONFLICT (user_id, week_year)
     DO UPDATE SET
       event_id = EXCLUDED.event_id,
       required_stake_ledger = EXCLUDED.required_stake_ledger,
       completed = EXCLUDED.completed,
       completed_at = EXCLUDED.completed_at,
       penalty_applied = EXCLUDED.penalty_applied,
       penalty_amount_ledger = EXCLUDED.penalty_amount_ledger,
       updated_at = NOW()`,
    [userId, weekYear, eventId, requiredStakeLedger, completed]
  );
};

const getWeek = async (fnName) => {
  const result = await db.query(`SELECT ${fnName}() AS week`);
  return result.rows[0].week;
};

describe('Weekly assignment completion counts multi-outcome trades', () => {
  afterAll(async () => {
    if (cleanup.marketOutcomeUpdates.size) {
      await db.query('DELETE FROM market_outcome_updates WHERE id = ANY($1::int[])', [Array.from(cleanup.marketOutcomeUpdates)]);
    }
    if (cleanup.eventOutcomes.size) {
      await db.query('DELETE FROM event_outcomes WHERE id = ANY($1::int[])', [Array.from(cleanup.eventOutcomes)]);
    }
    if (cleanup.users.size) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    await db.getPool().end();
  });

  test('process-completed marks a user complete for a multiple_choice trade journaled in market_outcome_updates', async () => {
    const timestamp = Date.now();
    const adminEmail = `weekly_outcome_admin_${timestamp}@example.com`;
    const adminPassword = 'testpass123';
    const adminId = await createUser({
      email: adminEmail,
      username: `weekly_outcome_admin_${timestamp}`,
      password: adminPassword,
      rpBalanceLedger: 1_000_000_000
    });
    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', adminId]);

    const eligibleUserId = await createUser({
      email: `weekly_outcome_eligible_${timestamp}@example.com`,
      username: `weekly_outcome_eligible_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 1_000_000_000 // 1000 RP -> required 10 RP
    });

    const ineligibleUserId = await createUser({
      email: `weekly_outcome_ineligible_${timestamp}@example.com`,
      username: `weekly_outcome_ineligible_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 1_000_000_000 // 1000 RP -> required 10 RP
    });

    const eventId = await createMultipleChoiceEvent({
      title: `Weekly Outcome Completion Event ${timestamp}`,
      closingDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    });
    const outcomeId = await createOutcome({ eventId, outcomeKey: 'a', label: 'Option A' });

    const previousWeek = await getWeek('get_previous_week');

    await db.query(`
      UPDATE users
      SET weekly_assigned_event_id = $1,
          weekly_assignment_week = $2,
          weekly_assignment_completed = false,
          weekly_assignment_completed_at = NULL
      WHERE id = ANY($3::int[])
    `, [eventId, previousWeek, [eligibleUserId, ineligibleUserId]]);

    await upsertWeeklyAssignment({
      userId: eligibleUserId,
      weekYear: previousWeek,
      eventId,
      requiredStakeLedger: 10_000_000,
      completed: false
    });

    await upsertWeeklyAssignment({
      userId: ineligibleUserId,
      weekYear: previousWeek,
      eventId,
      requiredStakeLedger: 10_000_000,
      completed: false
    });

    const previousWeekStart = await db.query('SELECT date_trunc(\'week\', NOW() - INTERVAL \'1 week\') AS start');
    const createdAt = new Date(new Date(previousWeekStart.rows[0].start).getTime() + 60 * 60 * 1000);

    // Eligible user trades the assigned multi-outcome event; this journals into
    // market_outcome_updates (not market_updates) and must still satisfy the 1% requirement.
    await insertMarketOutcomeUpdate({
      userId: eligibleUserId,
      eventId,
      outcomeId,
      stakeAmount: 15, // meets 10 RP requirement
      createdAt
    });

    // Ineligible user stakes below the requirement.
    await insertMarketOutcomeUpdate({
      userId: ineligibleUserId,
      eventId,
      outcomeId,
      stakeAmount: 5, // below 10 RP requirement
      createdAt
    });

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email: adminEmail, password: adminPassword });

    const adminToken = loginRes.body.token;
    expect(adminToken).toBeDefined();

    const res = await request(app)
      .post('/api/weekly/process-completed')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.week).toBe(previousWeek);

    const userRes = await db.query(
      `SELECT id, weekly_assignment_completed
       FROM users
       WHERE id = ANY($1::int[])
       ORDER BY id`,
      [[eligibleUserId, ineligibleUserId]]
    );

    const eligible = userRes.rows.find((row) => row.id === eligibleUserId);
    const ineligible = userRes.rows.find((row) => row.id === ineligibleUserId);

    expect(eligible.weekly_assignment_completed).toBe(true);
    expect(ineligible.weekly_assignment_completed).toBe(false);

    const assignmentRes = await db.query(
      `SELECT completed FROM weekly_user_assignments WHERE user_id = $1 AND week_year = $2`,
      [eligibleUserId, previousWeek]
    );
    expect(assignmentRes.rows[0].completed).toBe(true);
  });

  test('getUserWeeklyStatus reflects a current-week multi-outcome trade via has_stake', async () => {
    const timestamp = Date.now();
    const email = `weekly_outcome_status_${timestamp}@example.com`;
    const username = `weekly_outcome_status_${timestamp}`;
    const password = 'testpass123';

    const userId = await createUser({
      email,
      username,
      password,
      rpBalanceLedger: 1_000_000_000 // 1000 RP -> weekly requirement should be 10 RP
    });
    const eventId = await createMultipleChoiceEvent({
      title: `Weekly Outcome Status Event ${timestamp}`,
      closingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    const outcomeId = await createOutcome({ eventId, outcomeKey: 'b', label: 'Option B' });

    const currentWeek = await getWeek('get_current_week');

    await db.query(
      `UPDATE users
       SET weekly_assigned_event_id = $1,
           weekly_assignment_week = $2,
           weekly_assignment_completed = false,
           weekly_assignment_completed_at = NULL
       WHERE id = $3`,
      [eventId, currentWeek, userId]
    );

    await upsertWeeklyAssignment({
      userId,
      weekYear: currentWeek,
      eventId,
      requiredStakeLedger: 10_000_000,
      completed: false
    });

    await insertMarketOutcomeUpdate({
      userId,
      eventId,
      outcomeId,
      stakeAmount: 2,
      createdAt: new Date()
    });

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email, password });

    const token = loginRes.body.token;
    expect(token).toBeDefined();

    const statusRes = await request(app)
      .get(`/api/weekly/user/${userId}/status`)
      .set('Authorization', `Bearer ${token}`);

    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body.success).toBe(true);
    expect(statusRes.body.assignment).toBeTruthy();
    expect(statusRes.body.assignment.event_id).toBe(eventId);
    expect(statusRes.body.assignment.has_stake).toBe(true);
    expect(Number(statusRes.body.assignment.stake_amount)).toBeGreaterThanOrEqual(2);
  });
});
