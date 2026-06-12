const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createVerifiedUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  const password = 'testpass123';

  await request(app).post('/api/users/register').send({ username, email, password });
  const loginRes = await request(app).post('/api/login').send({ email, password });
  const userRow = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const id = userRow.rows[0].id;

  // Tier 2 so the user may manage keys and the agent may trade.
  await db.query(
    `UPDATE users SET verification_tier = 2, email_verified_at = NOW() WHERE id = $1`,
    [id]
  );

  return { id, email, username, password, token: loginRes.body.token };
};

describe('Agent API keys', () => {
  const cleanup = { userIds: [], eventIds: [] };

  afterAll(async () => {
    if (cleanup.eventIds.length > 0) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('full lifecycle: create (one per user), authenticate, revoke', async () => {
    const user = await createVerifiedUser('agentkeyuser');
    cleanup.userIds.push(user.id);

    const created = await request(app)
      .post('/api/users/me/api-keys')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'my agent' });
    expect(created.statusCode).toBe(201);
    const apiKey = created.body.apiKey;
    expect(apiKey).toMatch(/^sk_live_/);

    // One key per user.
    const second = await request(app)
      .post('/api/users/me/api-keys')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'another' });
    expect(second.statusCode).toBe(400);
    expect(second.body.error).toMatch(/already exists/i);

    // Key authenticates and resolves to the owning user.
    const whoami = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(whoami.statusCode).toBe(200);
    expect(whoami.body.id).toBe(user.id);

    // Revoke; the key stops working.
    const keys = await request(app)
      .get('/api/users/me/api-keys')
      .set('Authorization', `Bearer ${user.token}`);
    expect(keys.body.keys).toHaveLength(1);

    const revoked = await request(app)
      .delete(`/api/users/me/api-keys/${keys.body.keys[0].id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(afterRevoke.statusCode).toBe(403);
  });

  test('agent keys are locked out of sensitive surfaces', async () => {
    const user = await createVerifiedUser('agentlockout');
    cleanup.userIds.push(user.id);

    const created = await request(app)
      .post('/api/users/me/api-keys')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'lockout agent' });
    const apiKey = created.body.apiKey;

    // Key management itself.
    const mintMore = await request(app)
      .post('/api/users/me/api-keys')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'sneaky' });
    expect(mintMore.statusCode).toBe(403);

    // E2EE relay.
    const mls = await request(app)
      .get('/api/mls/groups')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(mls.statusCode).toBe(403);

    // Credentials and account lifecycle.
    for (const [method, path] of [
      ['get', '/api/users/master-key'],
      ['post', '/api/users/change-password'],
      ['delete', '/api/me']
    ]) {
      const res = await request(app)[method](path)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({});
      expect(res.statusCode).toBe(403);
    }

    // Admin surface, even if the owner were an admin.
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [user.id]);
    const admin = await request(app)
      .get('/api/admin/persuasion-score/status')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(admin.statusCode).toBe(403);
  });

  test('agent can trade with idempotency-key replay protection', async () => {
    const user = await createVerifiedUser('agenttrader');
    cleanup.userIds.push(user.id);
    await db.query('UPDATE users SET rp_balance_ledger = 1000000000 WHERE id = $1', [user.id]);

    const created = await request(app)
      .post('/api/users/me/api-keys')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'trader agent' });
    const apiKey = created.body.apiKey;

    const event = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake)
       VALUES ('Agent CLI test market', 'cli', NOW() + INTERVAL '10 days', 'binary', 0.5, 10.0)
       RETURNING id`
    );
    cleanup.eventIds.push(event.rows[0].id);

    const tradeReq = () => request(app)
      .post(`/api/events/${event.rows[0].id}/update`)
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', 'agent-trade-1')
      .send({ stake: 5, target_prob: 0.55 });

    const first = await tradeReq();
    // The prediction engine may be unreachable in test environments; the
    // idempotency layer must replay whatever the first response was.
    const second = await tradeReq();
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
  });
});
