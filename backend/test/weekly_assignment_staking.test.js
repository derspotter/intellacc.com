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

    const userId = await createUser({ email, username, password });
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
  });

  test('process-completed rewards stakes from previous week', async () => {
    const timestamp = Date.now();
    const email = `weekly_reward_${timestamp}@example.com`;
    const username = `weekly_reward_${timestamp}`;
    const password = 'testpass123';
    const initialLedger = 0;

    const userId = await createUser({ email, username, password, rpBalanceLedger: initialLedger });
    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', userId]);
    const eventId = await createEvent({
      title: `Weekly Reward Event ${timestamp}`,
      closingDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    });

    const previousWeek = await getWeek('get_previous_week');

    await db.query(
      `UPDATE users
       SET weekly_assigned_event_id = $1,
           weekly_assignment_week = $2,
           weekly_assignment_completed = false,
           weekly_assignment_completed_at = NULL
       WHERE id = $3`,
      [eventId, previousWeek, userId]
    );

    const previousWeekStart = await db.query('SELECT date_trunc(\'week\', NOW() - INTERVAL \'1 week\') AS start');
    const createdAt = new Date(new Date(previousWeekStart.rows[0].start).getTime() + 60 * 60 * 1000);

    await insertMarketUpdate({
      userId,
      eventId,
      stakeAmount: 5,
      createdAt
    });

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email, password });

    const adminToken = loginRes.body.token;
    expect(adminToken).toBeDefined();

    const res = await request(app)
      .post('/api/weekly/process-completed')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.week).toBe(previousWeek);

    const userRes = await db.query(
      'SELECT weekly_assignment_completed, rp_balance_ledger FROM users WHERE id = $1',
      [userId]
    );

    expect(userRes.rows[0].weekly_assignment_completed).toBe(true);
    expect(Number(userRes.rows[0].rp_balance_ledger)).toBe(50_000_000);
  });
});
