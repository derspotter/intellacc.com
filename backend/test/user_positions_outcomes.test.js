const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

describe('GET /users/:id/positions with multi-outcome holdings', () => {
  const cleanup = { events: new Set(), users: new Set() };

  const makeUser = async (label) => {
    const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const email = `${unique}@example.com`;
    const password = 'testpass123';
    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await db.query(
      `INSERT INTO users (email, username, password_hash, created_at, verification_tier)
       VALUES ($1, $2, $3, NOW(), 2) RETURNING id`,
      [email, unique, passwordHash]
    );
    const loginRes = await request(app).post('/api/login').send({ email, password });
    expect(loginRes.statusCode).toBe(200);
    return { id: userResult.rows[0].id, token: loginRes.body.token };
  };

  afterAll(async () => {
    for (const eventId of cleanup.events) {
      await db.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
    for (const userId of cleanup.users) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('returns binary and outcome positions side by side', async () => {
    const user = await makeUser('positions_union');
    cleanup.users.add(user.id);

    // Binary position
    const binaryEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type)
       VALUES ('Binary pos test', 'x', NOW() + INTERVAL '7 days', 'binary') RETURNING id`
    );
    const binaryEventId = binaryEvent.rows[0].id;
    cleanup.events.add(binaryEventId);
    await db.query(
      `INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares)
       VALUES ($1, $2, 4.5, 0)`,
      [user.id, binaryEventId]
    );

    // Multi-outcome position
    const mcEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type)
       VALUES ('MC pos test', 'x', NOW() + INTERVAL '7 days', 'multiple_choice') RETURNING id`
    );
    const mcEventId = mcEvent.rows[0].id;
    cleanup.events.add(mcEventId);
    const outcomeRes = await db.query(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES ($1, 'choice_1', 'Alpha', 0) RETURNING id`,
      [mcEventId]
    );
    const outcomeId = outcomeRes.rows[0].id;
    await db.query(
      `INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger, version)
       VALUES ($1, $2, $3, 7.25, 3000000, 1)`,
      [user.id, mcEventId, outcomeId]
    );

    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    const rows = res.body;

    const binaryRow = rows.find((r) => Number(r.event_id) === binaryEventId);
    expect(binaryRow).toBeDefined();
    expect(Number(binaryRow.yes_shares)).toBeCloseTo(4.5);
    expect(binaryRow.outcome_id).toBeNull();

    const outcomeRow = rows.find((r) => Number(r.event_id) === mcEventId);
    expect(outcomeRow).toBeDefined();
    expect(Number(outcomeRow.outcome_id)).toBe(Number(outcomeId));
    expect(outcomeRow.outcome_label).toBe('Alpha');
    expect(Number(outcomeRow.outcome_shares)).toBeCloseTo(7.25);
    expect(Number(outcomeRow.outcome_staked_rp)).toBeCloseTo(3); // 3_000_000 ledger / 1e6
    expect(outcomeRow.event_type).toBe('multiple_choice');
  });
});
