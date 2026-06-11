const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  const userRow = await db.query('SELECT id FROM users WHERE email = $1', [email]);

  return {
    id: userRow.rows[0].id,
    email,
    username,
    password,
    token: loginRes.body.token
  };
};

describe('Prediction analytics dashboard', () => {
  const cleanup = {
    userIds: [],
    eventIds: []
  };

  afterAll(async () => {
    if (cleanup.eventIds.length > 0) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('returns summary, recent predictions, and open positions for the current user', async () => {
    const user = await createUser('analyticsuser');
    cleanup.userIds.push(user.id);

    await db.query(
      'UPDATE users SET rp_balance_ledger = $1, rp_staked_ledger = $2 WHERE id = $3',
      [920000000, 80000000, user.id]
    );

    const eventOne = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake)
       VALUES ($1, $2, NOW() + INTERVAL '10 days', 'binary', 0.62, 125.0)
       RETURNING id`,
      ['Will inflation fall by Q4?', 'Macro event']
    );
    const eventTwo = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake, outcome)
       VALUES ($1, $2, NOW() + INTERVAL '20 days', 'binary', 0.41, 95.0, 'yes')
       RETURNING id`,
      ['Will rates be cut?', 'Rates event']
    );
    const eventThree = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake, outcome)
       VALUES ($1, $2, NOW() + INTERVAL '30 days', 'binary', 0.55, 110.0, 'no')
       RETURNING id`,
      ['Will unemployment rise?', 'Labor event']
    );
    cleanup.eventIds.push(eventOne.rows[0].id, eventTwo.rows[0].id, eventThree.rows[0].id);

    await db.query(
      `INSERT INTO predictions
       (user_id, event_id, event, prediction_value, confidence, prediction_type, outcome, created_at)
       VALUES
       ($1, $2, $3, 'yes', 78, 'binary', NULL, NOW() - INTERVAL '1 day'),
       ($1, $4, $5, 'no', 64, 'binary', 'correct', NOW() - INTERVAL '2 days'),
       ($1, $6, $7, 'yes', 55, 'binary', 'incorrect', NOW() - INTERVAL '3 days')`,
      [
        user.id,
        eventOne.rows[0].id,
        'Will inflation fall by Q4?',
        eventTwo.rows[0].id,
        'Will rates be cut?',
        eventThree.rows[0].id,
        'Will unemployment rise?'
      ]
    );

    await db.query(
      `INSERT INTO user_shares
       (user_id, event_id, yes_shares, no_shares, total_staked_ledger, staked_yes_ledger, staked_no_ledger, last_updated)
       VALUES ($1, $2, 12.5, 0, 80000000, 80000000, 0, NOW())`,
      [user.id, eventOne.rows[0].id]
    );

    await db.query(
      `INSERT INTO market_updates
       (user_id, event_id, prev_prob, new_prob, share_type, stake_amount, stake_amount_ledger, shares_acquired, hold_until, created_at)
       VALUES ($1, $2, 0.55, 0.62, 'yes', 80.0, 80000000, 12.5, NOW() + INTERVAL '5 days', NOW() - INTERVAL '1 day')`,
      [user.id, eventOne.rows[0].id]
    );

    const res = await request(app)
      .get('/api/analytics/predictions/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.summary.total_predictions).toBe(3);
    expect(res.body.summary.pending_predictions).toBe(1);
    expect(res.body.summary.resolved_predictions).toBe(2);
    expect(res.body.summary.correct_predictions).toBe(1);
    expect(res.body.summary.incorrect_predictions).toBe(1);
    expect(res.body.summary.accuracy_percent).toBe(50);
    expect(res.body.activity.open_positions).toBe(1);
    expect(res.body.activity.active_markets).toBe(1);
    expect(res.body.activity.available_reputation).toBe(920);
    expect(res.body.activity.staked_reputation).toBe(80);
    expect(res.body.recent_predictions).toHaveLength(3);
    expect(res.body.open_positions).toHaveLength(1);
    expect(res.body.open_positions[0].event_title).toBe('Will inflation fall by Q4?');
    expect(res.body.open_positions[0].exposure_label).toBe('YES');
  });
});
