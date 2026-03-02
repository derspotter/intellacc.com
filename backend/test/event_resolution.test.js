const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const makeUser = async (label, role = 'user', verificationTier = 2) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  const username = unique;
  const password = 'testpass123';
  const passwordHash = await bcrypt.hash(password, 10);

  const userResult = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, role, verification_tier)
     VALUES ($1, $2, $3, NOW(), $4, $5) RETURNING id`,
    [email, username, passwordHash, role, verificationTier]
  );

  const userId = userResult.rows[0].id;

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  expect(loginRes.statusCode).toBe(200);
  return { id: userId, token: loginRes.body.token };
};

const createEvent = async ({ outcome = null, closingDate = new Date(Date.now() + 24 * 60 * 60 * 1000) } = {}) => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, outcome)
     VALUES ($1, $2, $3, $4) RETURNING id, title, details, closing_date, outcome`,
    [`Resolution test ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'Resolved in test', closingDate, outcome]
  );

  return result.rows[0];
};

describe('Event resolution endpoint', () => {
  const cleanup = {
    events: new Set(),
    users: new Set()
  };

  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'resolved' })
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

  test('admin can resolve an open market', async () => {
    const admin = await makeUser('resolved_admin', 'admin');
    const event = await createEvent();

    cleanup.users.add(admin.id);
    cleanup.events.add(event.id);

    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ outcome: 'yes' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('event.outcome', 'yes');
    expect(res.body.event).toHaveProperty('numerical_outcome');
    expect(Number(res.body.event.numerical_outcome)).toBe(1);
    expect(res.body).toHaveProperty('message');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${event.id}/market-resolve`);
    expect(calledOptions?.method).toBe('POST');
    const payload = JSON.parse(calledOptions?.body || '{}');
    expect(payload).toEqual({ outcome: true });

    const resolved = await db.query('SELECT outcome, numerical_outcome FROM events WHERE id = $1', [event.id]);
    expect(resolved.rows[0].outcome).toBe('yes');
    expect(Number(resolved.rows[0].numerical_outcome)).toBe(1);
  });

  test('non-admin users cannot resolve markets', async () => {
    const user = await makeUser('resolved_non_admin');
    const event = await createEvent();

    cleanup.users.add(user.id);
    cleanup.events.add(event.id);

    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ outcome: 'no' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('error');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects invalid market outcome payload', async () => {
    const admin = await makeUser('resolved_admin_invalid', 'admin');
    const event = await createEvent();

    cleanup.users.add(admin.id);
    cleanup.events.add(event.id);

    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ outcome: 'invalid-value' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('message');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects re-resolving a market', async () => {
    const admin = await makeUser('resolved_admin_twice', 'admin');
    const event = await createEvent({ outcome: 'yes' });

    cleanup.users.add(admin.id);
    cleanup.events.add(event.id);

    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ outcome: 'no' });

    expect(res.statusCode).toBe(409);
    expect(res.body).toHaveProperty('message');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
