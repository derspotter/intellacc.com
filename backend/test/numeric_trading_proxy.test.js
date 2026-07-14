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

const createNumericEvent = async () => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type)
     VALUES ($1, $2, NOW() + INTERVAL '7 days', 'numeric')
     RETURNING id`,
    [`Numeric proxy test ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'test']
  );
  return result.rows[0].id;
};

describe('Numeric trading proxy routes', () => {
  const cleanup = { events: new Set(), users: new Set() };
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        alpha: 0.5,
        cost_ledger: 50000000,
        market_version: 1,
        post_distribution: [],
        deltas: []
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

  test('numeric-quote forwards budget_ledger and target to the engine', async () => {
    const user = await makeUser('numquote_ok');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        alpha: 0.39,
        cost_ledger: 50000000,
        market_version: 0,
        post_distribution: [0.1, 0.9],
        deltas: [1.5, -1.5]
      })
    });

    const res = await request(app)
      .get(`/api/events/${eventId}/numeric-quote`)
      .set('Authorization', `Bearer ${user.token}`)
      .query({ budget_ledger: 50000000, target: '1,0' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('cost_ledger', 50000000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(
      `http://prediction-engine:3001/events/${eventId}/numeric-quote?budget_ledger=50000000&target=1%2C0`
    );
  });

  test('numeric-quote requires auth', async () => {
    const eventId = await createNumericEvent();
    cleanup.events.add(eventId);

    const res = await request(app)
      .get(`/api/events/${eventId}/numeric-quote`)
      .query({ budget_ledger: 50000000, target: '1,0' });

    expect(res.statusCode).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('numeric-quote passes through engine error bodies', async () => {
    const user = await makeUser('numquote_err');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid budget_ledger: must be positive' })
    });

    const res = await request(app)
      .get(`/api/events/${eventId}/numeric-quote`)
      .set('Authorization', `Bearer ${user.token}`)
      .query({ budget_ledger: 0, target: '1,0' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Invalid budget_ledger: must be positive');
  });

  test('numeric-trade forwards user_id (from JWT, never body), target, budget_ledger, max_cost_ledger, market_version', async () => {
    const user = await makeUser('numtrade_ok');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        event_id: eventId,
        trade_id: 1,
        alpha: 0.5,
        cost_ledger: 50000000,
        market_version: 1,
        post_distribution: [0.1, 0.9],
        deltas: [1.5, -1.5]
      })
    });

    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-trade`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        user_id: 99999999, // must be ignored - injected from JWT instead
        target: [1, 0],
        budget_ledger: 50000000,
        max_cost_ledger: 60000000,
        market_version: 0
      });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('trade_id', 1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${eventId}/numeric-trade`);
    expect(JSON.parse(calledOptions.body)).toEqual({
      user_id: user.id,
      target: [1, 0],
      budget_ledger: 50000000,
      max_cost_ledger: 60000000,
      market_version: 0
    });
  });

  test('numeric-trade requires auth and phone verification', async () => {
    const eventId = await createNumericEvent();
    cleanup.events.add(eventId);

    const anon = await request(app)
      .post(`/api/events/${eventId}/numeric-trade`)
      .send({ target: [1, 0], budget_ledger: 50000000, max_cost_ledger: 60000000, market_version: 0 });
    expect(anon.statusCode).toBe(401);

    const tier1 = await makeUser('numtrade_tier1', 1);
    cleanup.users.add(tier1.id);
    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-trade`)
      .set('Authorization', `Bearer ${tier1.token}`)
      .send({ target: [1, 0], budget_ledger: 50000000, max_cost_ledger: 60000000, market_version: 0 });
    expect(res.statusCode).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('numeric-trade passes through the engine 409 stale-version body', async () => {
    const user = await makeUser('numtrade_409');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'market_version is stale; retry with the fresh quote',
        quote: { alpha: 0.4, cost_ledger: 10000000, market_version: 1 }
      })
    });

    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-trade`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ target: [1, 0], budget_ledger: 50000000, max_cost_ledger: 60000000, market_version: 0 });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('market_version is stale; retry with the fresh quote');
    expect(res.body.quote).toEqual({ alpha: 0.4, cost_ledger: 10000000, market_version: 1 });
  });

  test('numeric-trade returns 500 when engine is unreachable', async () => {
    const user = await makeUser('numtrade_500');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-trade`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ target: [1, 0], budget_ledger: 50000000, max_cost_ledger: 60000000, market_version: 0 });

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  test('numeric-sell forwards user_id (from JWT, never body) and market_version', async () => {
    const user = await makeUser('numsell_ok');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        event_id: eventId,
        trade_id: 2,
        market_version: 2,
        payout_ledger: 50000003
      })
    });

    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-sell`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ user_id: 99999999, market_version: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('payout_ledger', 50000003);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${eventId}/numeric-sell`);
    expect(JSON.parse(calledOptions.body)).toEqual({
      user_id: user.id,
      market_version: 1
    });
  });

  test('numeric-sell requires auth and phone verification', async () => {
    const eventId = await createNumericEvent();
    cleanup.events.add(eventId);

    const anon = await request(app)
      .post(`/api/events/${eventId}/numeric-sell`)
      .send({ market_version: 1 });
    expect(anon.statusCode).toBe(401);

    const tier1 = await makeUser('numsell_tier1', 1);
    cleanup.users.add(tier1.id);
    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-sell`)
      .set('Authorization', `Bearer ${tier1.token}`)
      .send({ market_version: 1 });
    expect(res.statusCode).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('numeric-sell passes through the engine 409 stale-version body', async () => {
    const user = await makeUser('numsell_409');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'market_version is stale; retry with the current version',
        market_version: 3
      })
    });

    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-sell`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ market_version: 0 });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('market_version is stale; retry with the current version');
    expect(res.body.market_version).toBe(3);
  });

  test('numeric-sell returns 500 when engine is unreachable', async () => {
    const user = await makeUser('numsell_500');
    const eventId = await createNumericEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .post(`/api/events/${eventId}/numeric-sell`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ market_version: 1 });

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});
