const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const makeUser = async (label, verificationTier = 2) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  const username = unique;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });
  expect(loginRes.statusCode).toBe(200);

  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;

  await db.query('UPDATE users SET verification_tier = $1 WHERE id = $2', [verificationTier, userId]);

  return { id: userId, token: loginRes.body.token };
};

const createEvent = async ({
  outcome = null,
  closingDate = new Date(Date.now() + (24 * 60 * 60 * 1000))
}) => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, outcome)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Lifecycle market ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'Lifecycle coverage test', closingDate, outcome]
  );

  return result.rows[0];
};

describe('Market lifecycle rejection coverage', () => {
  const cleanup = {
    users: new Set(),
    events: new Set()
  };

  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        new_prob: 0.55,
        cumulative_stake: 4.0,
        market_update_id: 99
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

  test('rejects closed market updates before calling prediction engine', async () => {
    const user = await makeUser('closed_market_user');
    const closedEvent = await createEvent({
      closingDate: new Date(Date.now() - 5 * 60 * 1000)
    });

    cleanup.users.add(user.id);
    cleanup.events.add(closedEvent.id);

    const res = await request(app)
      .post(`/api/events/${closedEvent.id}/update`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ user_id: user.id, stake: 1.0, target_prob: 0.6 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Market closed');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects resolved market updates before calling prediction engine', async () => {
    const user = await makeUser('resolved_market_user');
    const resolvedEvent = await createEvent({
      outcome: 'resolved'
    });

    cleanup.users.add(user.id);
    cleanup.events.add(resolvedEvent.id);

    const res = await request(app)
      .post(`/api/events/${resolvedEvent.id}/update`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ user_id: user.id, stake: 1.0, target_prob: 0.6 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Market resolved');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('does not block open-market updates when event is still active', async () => {
    const user = await makeUser('open_market_user');
    const activeEvent = await createEvent({
      closingDate: new Date(Date.now() + 5 * 60 * 1000)
    });

    cleanup.users.add(user.id);
    cleanup.events.add(activeEvent.id);

    const res = await request(app)
      .post(`/api/events/${activeEvent.id}/update`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ user_id: user.id, stake: 1.0, target_prob: 0.6 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('market_update_id', 99);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('sell route rejects closed market updates before calling prediction engine', async () => {
    const user = await makeUser('closed_market_sell_user');
    const closedEvent = await createEvent({
      closingDate: new Date(Date.now() - 5 * 60 * 1000)
    });

    cleanup.users.add(user.id);
    cleanup.events.add(closedEvent.id);

    const res = await request(app)
      .post(`/api/events/${closedEvent.id}/sell`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ share_type: 'yes', amount: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Market closed');
    expect(res.body.event_id).toBe(closedEvent.id);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sell route rejects resolved markets before calling prediction engine', async () => {
    const user = await makeUser('resolved_market_sell_user');
    const resolvedEvent = await createEvent({
      outcome: 'resolved'
    });

    cleanup.users.add(user.id);
    cleanup.events.add(resolvedEvent.id);

    const res = await request(app)
      .post(`/api/events/${resolvedEvent.id}/sell`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ share_type: 'yes', amount: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Market resolved');
    expect(res.body.event_id).toBe(resolvedEvent.id);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sell route allows operations when event is still active', async () => {
    const user = await makeUser('open_market_sell_user');
    const activeEvent = await createEvent({
      closingDate: new Date(Date.now() + 5 * 60 * 1000)
    });

    cleanup.users.add(user.id);
    cleanup.events.add(activeEvent.id);

    const res = await request(app)
      .post(`/api/events/${activeEvent.id}/sell`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ share_type: 'yes', amount: 2 });

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('does not block open-market sells when event is still active', async () => {
    const user = await makeUser('open_market_user_sell');
    const activeEvent = await createEvent({
      closingDate: new Date(Date.now() + 5 * 60 * 1000)
    });

    cleanup.users.add(user.id);
    cleanup.events.add(activeEvent.id);

    const res = await request(app)
      .post(`/api/events/${activeEvent.id}/sell`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ share_type: 'yes', amount: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('market_update_id', 99);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
