const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const makeUser = async (label, verificationTier = 2) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  const password = 'testpass123';
  const passwordHash = await bcrypt.hash(password, 10);
  const userResult = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, verification_tier)
     VALUES ($1, $2, $3, NOW(), $4) RETURNING id`,
    [email, unique, passwordHash, verificationTier]
  );
  const loginRes = await request(app).post('/api/login').send({ email, password });
  expect(loginRes.statusCode).toBe(200);
  return { id: userResult.rows[0].id, token: loginRes.body.token };
};

const createMultiEvent = async ({ outcome = null } = {}) => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type, outcome)
     VALUES ($1, $2, NOW() + INTERVAL '7 days', 'multiple_choice', $3)
     RETURNING id`,
    [`Outcome proxy test ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'test', outcome]
  );
  const eventId = result.rows[0].id;
  const outcomeRes = await db.query(
    `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
     VALUES ($1, 'choice_1', 'Option A', 0), ($1, 'choice_2', 'Option B', 1)
     RETURNING id`,
    [eventId]
  );
  return { eventId, outcomeIds: outcomeRes.rows.map((r) => r.id) };
};

describe('Outcome trading proxy routes', () => {
  const cleanup = { events: new Set(), users: new Set() };
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payout: 12.5,
        market_prob: 0.4,
        current_cost_c: 3500,
        outcomes: []
      })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(async () => {
    for (const eventId of cleanup.events) {
      await db.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
    for (const userId of cleanup.users) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('sell-outcome forwards user, outcome and amount to the engine', async () => {
    const user = await makeUser('sellout_ok');
    const { eventId, outcomeIds } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ outcome_id: outcomeIds[0], amount: 3.5 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('payout', 12.5);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${eventId}/sell-outcome`);
    expect(JSON.parse(calledOptions.body)).toEqual({
      user_id: user.id,
      outcome_id: Number(outcomeIds[0]),
      amount: 3.5
    });
  });

  test('sell-outcome rejects bad payloads without calling the engine', async () => {
    const user = await makeUser('sellout_bad');
    const { eventId } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    for (const body of [
      { outcome_id: 0, amount: 1 },
      { outcome_id: 'abc', amount: 1 },
      { outcome_id: 1, amount: 0 },
      { outcome_id: 1, amount: -2 },
      { outcome_id: 1 }
    ]) {
      const res = await request(app)
        .post(`/api/events/${eventId}/sell-outcome`)
        .set('Authorization', `Bearer ${user.token}`)
        .send(body);
      expect(res.statusCode).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sell-outcome requires auth and phone verification', async () => {
    const { eventId } = await createMultiEvent();
    cleanup.events.add(eventId);

    const anon = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .send({ outcome_id: 1, amount: 1 });
    expect(anon.statusCode).toBe(401);

    const tier1 = await makeUser('sellout_tier1', 1);
    cleanup.users.add(tier1.id);
    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${tier1.token}`)
      .send({ outcome_id: 1, amount: 1 });
    expect(res.statusCode).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sell-outcome blocks resolved events before reaching the engine', async () => {
    const user = await makeUser('sellout_resolved');
    const { eventId, outcomeIds } = await createMultiEvent({ outcome: 'resolved_outcome_1' });
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ outcome_id: outcomeIds[0], amount: 1 });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('update-outcome forwards stake and outcome_id (first coverage)', async () => {
    const user = await makeUser('updout_ok');
    const { eventId, outcomeIds } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ market_prob: 0.6, outcomes: [], shares_acquired: 5 })
    });

    const res = await request(app)
      .post(`/api/events/${eventId}/update-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ stake: 10, outcome_id: outcomeIds[1] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('shares_acquired', 5);
    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${eventId}/update-outcome`);
    expect(JSON.parse(calledOptions.body)).toEqual({
      user_id: user.id,
      stake: 10,
      outcome_id: Number(outcomeIds[1])
    });
  });

  test('sell-outcome passthrough engine errors (400)', async () => {
    const user = await makeUser('sellout_error_400');
    const { eventId, outcomeIds } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Insufficient shares in selected outcome' })
    });

    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ outcome_id: outcomeIds[0], amount: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Insufficient shares in selected outcome');
  });

  test('sell-outcome returns 500 when engine is unreachable', async () => {
    const user = await makeUser('sellout_error_500');
    const { eventId, outcomeIds } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ outcome_id: outcomeIds[0], amount: 1 });

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error', 'Failed to sell outcome shares');
  });
});
