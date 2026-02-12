const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(20000);

const cleanup = {
  users: new Set(),
  events: new Set(),
  marketUpdates: new Set()
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

const createEvent = async ({ title, closingDate }) => {
  const result = await db.query(
    `INSERT INTO events (title, closing_date, created_at, updated_at, market_prob, liquidity_b, cumulative_stake, q_yes, q_no)
     VALUES ($1, $2, NOW(), NOW(), 0.5, 5000, 0, 0, 0)
     RETURNING id`,
    [title, closingDate]
  );
  const id = result.rows[0].id;
  cleanup.events.add(id);
  return id;
};

const insertMarketUpdate = async ({ userId, eventId, stakeAmount, createdAt }) => {
  const prevProb = 0.5;
  const newProb = 0.5001;
  const sharesAcquired = 1;
  const shareType = 'yes';
  const holdUntil = new Date(Date.now() + 60 * 60 * 1000);
  const stakeLedger = Math.round(stakeAmount * 1_000_000);

  const result = await db.query(
    `INSERT INTO market_updates
     (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until, created_at, stake_amount_ledger)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [userId, eventId, prevProb, newProb, stakeAmount, sharesAcquired, shareType, holdUntil, createdAt, stakeLedger]
  );
  cleanup.marketUpdates.add(result.rows[0].id);
  return result.rows[0].id;
};

const upsertWeeklyAssignment = async ({
  userId,
  weekYear,
  eventId,
  requiredStakeLedger,
  completed = false,
  completedAt = null,
  penaltyApplied = false,
  penaltyAmountLedger = 0
}) => {
  await db.query(
    `INSERT INTO weekly_user_assignments
      (user_id, week_year, event_id, required_stake_ledger, completed, completed_at, penalty_applied, penalty_amount_ledger)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, week_year)
     DO UPDATE SET
       event_id = EXCLUDED.event_id,
       required_stake_ledger = EXCLUDED.required_stake_ledger,
       completed = EXCLUDED.completed,
       completed_at = EXCLUDED.completed_at,
       penalty_applied = EXCLUDED.penalty_applied,
       penalty_amount_ledger = EXCLUDED.penalty_amount_ledger,
       updated_at = NOW()`,
    [
      userId,
      weekYear,
      eventId,
      requiredStakeLedger,
      completed,
      completedAt,
      penaltyApplied,
      penaltyAmountLedger
    ]
  );
};

const getWeek = async (fnName) => {
  const result = await db.query(`SELECT ${fnName}() AS week`);
  return result.rows[0].week;
};

describe('Weekly assignment staking flow', () => {
  afterAll(async () => {
    if (cleanup.marketUpdates.size) {
      await db.query('DELETE FROM market_updates WHERE id = ANY($1::int[])', [Array.from(cleanup.marketUpdates)]);
    }
    if (cleanup.users.size) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    await db.getPool().end();
  });

  test('weekly status reflects stake in current week', async () => {
    const timestamp = Date.now();
    const email = `weekly_status_${timestamp}@example.com`;
    const username = `weekly_status_${timestamp}`;
    const password = 'testpass123';

    const userId = await createUser({
      email,
      username,
      password,
      rpBalanceLedger: 1_000_000_000 // 1000 RP -> weekly requirement should be 10 RP
    });
    const eventId = await createEvent({
      title: `Weekly Status Event ${timestamp}`,
      closingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });

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

    await insertMarketUpdate({
      userId,
      eventId,
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
    expect(statusRes.body.assignment.min_stake_rp).toBeDefined();
    expect(Number(statusRes.body.assignment.min_stake_rp)).toBeCloseTo(10, 2);
  });

  test('process-completed marks complete only when stake meets 1% requirement and gives no RP reward', async () => {
    const timestamp = Date.now();
    const adminEmail = `weekly_admin_${timestamp}@example.com`;
    const adminUsername = `weekly_admin_${timestamp}`;
    const adminPassword = 'testpass123';
    const adminId = await createUser({
      email: adminEmail,
      username: adminUsername,
      password: adminPassword,
      rpBalanceLedger: 1_000_000_000
    });
    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', adminId]);

    const eligibleUserId = await createUser({
      email: `weekly_eligible_${timestamp}@example.com`,
      username: `weekly_eligible_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 1_000_000_000 // 1000 RP -> required 10 RP
    });

    const ineligibleUserId = await createUser({
      email: `weekly_ineligible_${timestamp}@example.com`,
      username: `weekly_ineligible_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 1_000_000_000 // 1000 RP -> required 10 RP
    });

    const eventId = await createEvent({
      title: `Weekly Completion Event ${timestamp}`,
      closingDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    });

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

    await insertMarketUpdate({
      userId: eligibleUserId,
      eventId,
      stakeAmount: 15, // meets 10 RP requirement
      createdAt
    });

    await insertMarketUpdate({
      userId: ineligibleUserId,
      eventId,
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
      `SELECT id, weekly_assignment_completed, rp_balance_ledger
       FROM users
       WHERE id = ANY($1::int[])
       ORDER BY id`,
      [[eligibleUserId, ineligibleUserId]]
    );

    const eligible = userRes.rows.find((row) => row.id === eligibleUserId);
    const ineligible = userRes.rows.find((row) => row.id === ineligibleUserId);

    expect(eligible.weekly_assignment_completed).toBe(true);
    expect(ineligible.weekly_assignment_completed).toBe(false);

    // No reward should be added anymore.
    expect(Number(eligible.rp_balance_ledger)).toBe(1_000_000_000);
    expect(Number(ineligible.rp_balance_ledger)).toBe(1_000_000_000);
  });

  test('apply-decay penalizes missed users by 1% and never drops below 100 RP floor', async () => {
    const timestamp = Date.now();
    const adminEmail = `weekly_decay_admin_${timestamp}@example.com`;
    const adminPassword = 'testpass123';

    const adminId = await createUser({
      email: adminEmail,
      username: `weekly_decay_admin_${timestamp}`,
      password: adminPassword,
      rpBalanceLedger: 1_000_000_000
    });
    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', adminId]);

    const missedUserId = await createUser({
      email: `weekly_missed_${timestamp}@example.com`,
      username: `weekly_missed_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 1_000_000_000 // should become 990 RP
    });

    const completedUserId = await createUser({
      email: `weekly_completed_${timestamp}@example.com`,
      username: `weekly_completed_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 1_000_000_000 // should stay 1000 RP
    });

    const floorUserId = await createUser({
      email: `weekly_floor_${timestamp}@example.com`,
      username: `weekly_floor_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 100_000_000 // floor: should stay at 100 RP
    });

    const eventId = await createEvent({
      title: `Weekly Penalty Event ${timestamp}`,
      closingDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    });

    const previousWeek = await getWeek('get_previous_week');

    await db.query(
      `UPDATE users
       SET weekly_assigned_event_id = $1,
           weekly_assignment_week = $2,
           weekly_assignment_completed = false,
           weekly_assignment_completed_at = NULL
       WHERE id = ANY($3::int[])`,
      [eventId, previousWeek, [missedUserId, floorUserId]]
    );

    await db.query(
      `UPDATE users
       SET weekly_assigned_event_id = $1,
           weekly_assignment_week = $2,
           weekly_assignment_completed = true,
           weekly_assignment_completed_at = NOW()
       WHERE id = $3`,
      [eventId, previousWeek, completedUserId]
    );

    await upsertWeeklyAssignment({
      userId: missedUserId,
      weekYear: previousWeek,
      eventId,
      requiredStakeLedger: 10_000_000,
      completed: false
    });

    await upsertWeeklyAssignment({
      userId: floorUserId,
      weekYear: previousWeek,
      eventId,
      requiredStakeLedger: 1_000_000,
      completed: false
    });

    await upsertWeeklyAssignment({
      userId: completedUserId,
      weekYear: previousWeek,
      eventId,
      requiredStakeLedger: 10_000_000,
      completed: true,
      completedAt: new Date()
    });

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email: adminEmail, password: adminPassword });
    const adminToken = loginRes.body.token;
    expect(adminToken).toBeDefined();

    const penaltyRes = await request(app)
      .post('/api/weekly/apply-decay')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(penaltyRes.statusCode).toBe(200);
    expect(penaltyRes.body.success).toBe(true);
    expect(penaltyRes.body.week).toBe(previousWeek);

    const balancesRes = await db.query(
      `SELECT id, rp_balance_ledger
       FROM users
       WHERE id = ANY($1::int[])`,
      [[missedUserId, completedUserId, floorUserId]]
    );

    const missed = balancesRes.rows.find((row) => row.id === missedUserId);
    const completed = balancesRes.rows.find((row) => row.id === completedUserId);
    const floor = balancesRes.rows.find((row) => row.id === floorUserId);

    expect(Number(missed.rp_balance_ledger)).toBe(990_000_000);
    expect(Number(completed.rp_balance_ledger)).toBe(1_000_000_000);
    expect(Number(floor.rp_balance_ledger)).toBe(100_000_000);
  });

  test('apply-decay still penalizes previous-week misses after current-week assignment rollover', async () => {
    const timestamp = Date.now();
    const adminEmail = `weekly_rollover_admin_${timestamp}@example.com`;
    const adminPassword = 'testpass123';

    const adminId = await createUser({
      email: adminEmail,
      username: `weekly_rollover_admin_${timestamp}`,
      password: adminPassword,
      rpBalanceLedger: 1_000_000_000
    });
    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', adminId]);

    const missedUserId = await createUser({
      email: `weekly_rollover_missed_${timestamp}@example.com`,
      username: `weekly_rollover_missed_${timestamp}`,
      password: 'testpass123',
      rpBalanceLedger: 1_000_000_000
    });

    const previousEventId = await createEvent({
      title: `Weekly rollover previous event ${timestamp}`,
      closingDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    });

    const currentEventId = await createEvent({
      title: `Weekly rollover current event ${timestamp}`,
      closingDate: new Date(Date.now() + 52 * 24 * 60 * 60 * 1000)
    });

    const previousWeek = await getWeek('get_previous_week');
    const currentWeek = await getWeek('get_current_week');

    // Historical missed assignment.
    await upsertWeeklyAssignment({
      userId: missedUserId,
      weekYear: previousWeek,
      eventId: previousEventId,
      requiredStakeLedger: 10_000_000,
      completed: false,
      penaltyApplied: false
    });

    // Rollover user row to current week (this used to break decay when logic depended on users.weekly_assignment_week).
    await db.query(
      `UPDATE users
       SET weekly_assigned_event_id = $1,
           weekly_assignment_week = $2,
           weekly_assignment_completed = false,
           weekly_assignment_completed_at = NULL
       WHERE id = $3`,
      [currentEventId, currentWeek, missedUserId]
    );

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email: adminEmail, password: adminPassword });
    const adminToken = loginRes.body.token;
    expect(adminToken).toBeDefined();

    const penaltyRes = await request(app)
      .post('/api/weekly/apply-decay')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(penaltyRes.statusCode).toBe(200);
    expect(penaltyRes.body.success).toBe(true);
    expect(penaltyRes.body.week).toBe(previousWeek);

    const balanceRes = await db.query(
      'SELECT rp_balance_ledger FROM users WHERE id = $1',
      [missedUserId]
    );
    expect(Number(balanceRes.rows[0].rp_balance_ledger)).toBe(990_000_000);

    const assignmentRes = await db.query(
      `SELECT penalty_applied, penalty_amount_ledger
       FROM weekly_user_assignments
       WHERE user_id = $1 AND week_year = $2`,
      [missedUserId, previousWeek]
    );

    expect(assignmentRes.rows[0].penalty_applied).toBe(true);
    expect(Number(assignmentRes.rows[0].penalty_amount_ledger)).toBe(10_000_000);
  });
});
