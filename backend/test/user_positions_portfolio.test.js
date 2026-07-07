// GET /api/users/:id/positions: card-ready portfolio rows. Open positions
// include junk-hidden markets (the browse listing's hidden_at filter must
// never hide a user's own holdings); markets resolved within 7 days appear
// as position_kind 'resolved' derived from trade history.
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const makeUser = async (label) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  await request(app).post('/api/users/register').send({ username: unique, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  expect(loginRes.statusCode).toBe(200);
  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: userResult.rows[0].id, token: loginRes.body.token };
};

describe('GET /api/users/:id/positions portfolio', () => {
  const cleanup = { eventIds: [], userIds: [] };
  let user;

  beforeAll(async () => {
    user = await makeUser('portfolio_user');
    cleanup.userIds.push(user.id);
  });

  afterAll(async () => {
    if (cleanup.eventIds.length) {
      await db.query('DELETE FROM market_updates WHERE event_id = ANY($1::int[])', [cleanup.eventIds]);
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
    if (cleanup.userIds.length) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  const insertEvent = async (title, { hidden = false, outcome = null, resolvedAgoDays = null, eventType = 'binary' } = {}) => {
    const result = await db.query(
      `INSERT INTO events (title, closing_date, event_type, outcome, resolved_at, hidden_at, hidden_reason)
       VALUES ($1, NOW() + INTERVAL '30 days', $2, $3,
               CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - ($4::int * INTERVAL '1 day') END,
               $5, $6)
       RETURNING id`,
      [title, eventType, outcome, resolvedAgoDays, hidden ? new Date() : null, hidden ? 'llm: test junk' : null]
    );
    cleanup.eventIds.push(result.rows[0].id);
    return result.rows[0].id;
  };

  const insertBinaryShares = (eventId, yes = 10) =>
    db.query('INSERT INTO user_shares (user_id, event_id, yes_shares) VALUES ($1, $2, $3)', [user.id, eventId, yes]);

  const insertTrade = (eventId) =>
    db.query(
      `INSERT INTO market_updates (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until)
       VALUES ($1, $2, 0.5, 0.55, 10, 18, 'yes', NOW())`,
      [user.id, eventId]
    );

  const fetchPositions = async () => {
    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  test('open binary position carries card-ready event fields', async () => {
    const eventId = await insertEvent(`portfolio open ${Date.now()}`);
    await insertBinaryShares(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('open');
    expect(Number(row.yes_shares)).toBe(10);
    expect(row.event_title).toContain('portfolio open');
    expect(row.liquidity_b).not.toBeNull();
    expect(row.hidden_at).toBeNull();
  });

  test('junk-hidden market with a position is still returned, flagged via hidden_at', async () => {
    const eventId = await insertEvent(`portfolio hidden ${Date.now()}`, { hidden: true });
    await insertBinaryShares(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('open');
    expect(row.hidden_at).not.toBeNull();
  });

  test('multi-outcome position rows carry outcome labels', async () => {
    const eventId = await insertEvent(`portfolio mc ${Date.now()}`, { eventType: 'multiple_choice' });
    const outcomeResult = await db.query(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES ($1, 'choice_1', 'Alpha', 0) RETURNING id`,
      [eventId]
    );
    await db.query(
      `INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
       VALUES ($1, $2, $3, 12.5, 10000000)`,
      [user.id, eventId, outcomeResult.rows[0].id]
    );
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('open');
    expect(row.outcome_label).toBe('Alpha');
    expect(Number(row.outcome_shares)).toBeCloseTo(12.5);
  });

  test('market resolved 2 days ago with a prior trade appears as resolved', async () => {
    const eventId = await insertEvent(`portfolio resolved ${Date.now()}`, { outcome: 'resolved_yes', resolvedAgoDays: 2 });
    await insertTrade(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('resolved');
    expect(row.outcome).toBe('resolved_yes');
    expect(row.yes_shares).toBeNull();
  });

  test('market resolved 10 days ago is excluded', async () => {
    const eventId = await insertEvent(`portfolio stale ${Date.now()}`, { outcome: 'resolved_no', resolvedAgoDays: 10 });
    await insertTrade(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeUndefined();
  });

  test('recently resolved market the user never traded is excluded', async () => {
    const eventId = await insertEvent(`portfolio untraded ${Date.now()}`, { outcome: 'resolved_yes', resolvedAgoDays: 1 });
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeUndefined();
  });

  test("cannot fetch another user's positions", async () => {
    const other = await makeUser('portfolio_other');
    cleanup.userIds.push(other.id);
    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.statusCode).toBe(403);
  });
});
