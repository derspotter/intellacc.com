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

  return { id: userRow.rows[0].id, token: loginRes.body.token };
};

const createEvent = async ({ outcome = null }) => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type, outcome)
     VALUES ($1, 'calibration test', NOW() + INTERVAL '10 days', 'binary', $2)
     RETURNING id`,
    [`Calibration event ${Date.now()}_${Math.floor(Math.random() * 10000)}`, outcome]
  );
  return result.rows[0].id;
};

const insertTrade = async (userId, eventId, beliefProb, { createdOffsetMinutes = 0 } = {}) => {
  await db.query(
    `INSERT INTO market_updates
     (user_id, event_id, prev_prob, new_prob, share_type, stake_amount, stake_amount_ledger,
      shares_acquired, hold_until, belief_prob, created_at)
     VALUES ($1, $2, 0.5, 0.55, 'yes', 10.0, 10000000, 2.0, NOW(),
             $3, NOW() - INTERVAL '1 hour' + ($4 || ' minutes')::interval)`,
    [userId, eventId, beliefProb, String(createdOffsetMinutes)]
  );
};

describe('User calibration endpoint', () => {
  const cleanup = { userIds: [], eventIds: [] };

  afterAll(async () => {
    if (cleanup.eventIds.length > 0) {
      await db.query('DELETE FROM market_updates WHERE event_id = ANY($1::int[])', [cleanup.eventIds]);
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('buckets last stated belief per resolved binary market and scores Brier', async () => {
    const user = await createUser('calibuser');
    const bystander = await createUser('calibother');
    cleanup.userIds.push(user.id, bystander.id);

    const eYes = await createEvent({ outcome: 'resolved_yes' });
    const eNo = await createEvent({ outcome: 'resolved_no' });
    const eRevised = await createEvent({ outcome: 'resolved_yes' });
    const ePending = await createEvent({ outcome: null });
    const eNullBelief = await createEvent({ outcome: 'resolved_yes' });
    cleanup.eventIds.push(eYes, eNo, eRevised, ePending, eNullBelief);

    await insertTrade(user.id, eYes, 0.8);
    await insertTrade(user.id, eNo, 0.3);
    // Two beliefs on one market: only the LAST one counts.
    await insertTrade(user.id, eRevised, 0.4, { createdOffsetMinutes: 0 });
    await insertTrade(user.id, eRevised, 0.7, { createdOffsetMinutes: 30 });
    // Pending market and belief-less legacy trade: excluded.
    await insertTrade(user.id, ePending, 0.9);
    await insertTrade(user.id, eNullBelief, null);
    // Another user's belief must not leak in.
    await insertTrade(bystander.id, eYes, 0.1);

    const res = await request(app)
      .get(`/api/users/${user.id}/calibration`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.n).toBe(3);
    // Brier: mean((0.8-1)^2, (0.3-0)^2, (0.7-1)^2) = (0.04+0.09+0.09)/3
    expect(res.body.brier).toBeCloseTo(0.07333, 4);

    expect(res.body.buckets).toHaveLength(5);
    const [b1, b2, b3, b4, b5] = res.body.buckets;
    expect(b1).toMatchObject({ lower: 0, upper: 0.2, n: 0 });
    expect(b2).toMatchObject({ lower: 0.2, upper: 0.4, n: 1 });
    expect(b2.mean_belief).toBeCloseTo(0.3, 5);
    expect(b2.observed).toBeCloseTo(0, 5);
    expect(b3).toMatchObject({ lower: 0.4, upper: 0.6, n: 0 });
    expect(b4).toMatchObject({ lower: 0.6, upper: 0.8, n: 1 });
    expect(b4.mean_belief).toBeCloseTo(0.7, 5);
    expect(b4.observed).toBeCloseTo(1, 5);
    expect(b5).toMatchObject({ lower: 0.8, upper: 1, n: 1 });
    expect(b5.mean_belief).toBeCloseTo(0.8, 5);
    expect(b5.observed).toBeCloseTo(1, 5);
  });

  test('returns zero-state for a user with no resolved beliefs', async () => {
    const user = await createUser('calibempty');
    cleanup.userIds.push(user.id);

    const res = await request(app)
      .get(`/api/users/${user.id}/calibration`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.n).toBe(0);
    expect(res.body.brier).toBeNull();
    expect(res.body.buckets).toHaveLength(5);
    expect(res.body.buckets.every((b) => b.n === 0)).toBe(true);
  });
});
