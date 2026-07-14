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

  test('recently-resolved outcome market surfaces via market_outcome_updates alone', async () => {
    // Settlement deletes user_outcome_shares, so a resolved multi-outcome
    // market the user traded is reconstructed from trade history. That branch
    // OR's market_updates (binary trades) with market_outcome_updates
    // (outcome trades); a user who only ever traded outcomes has no
    // market_updates row, so the mou disjunct is the only thing that can
    // include the market. This guards that disjunct against regression.
    const user = await makeUser('positions_resolved_mou');
    cleanup.users.add(user.id);

    // Resolved multi-outcome event, resolved just now (inside the 7-day window),
    // with NO surviving share rows for the user.
    const resolvedEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, outcome, resolved_at)
       VALUES ('Resolved MC via mou', 'x', NOW() - INTERVAL '1 day', 'multiple_choice', 'Alpha', NOW())
       RETURNING id`
    );
    const resolvedEventId = resolvedEvent.rows[0].id;
    cleanup.events.add(resolvedEventId);
    const resolvedOutcome = await db.query(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES ($1, 'choice_1', 'Alpha', 0) RETURNING id`,
      [resolvedEventId]
    );
    const resolvedOutcomeId = resolvedOutcome.rows[0].id;
    // Trade-history row only — no user_outcome_shares (settlement deleted it),
    // and no market_updates row (this user never traded a binary market here).
    await db.query(
      `INSERT INTO market_outcome_updates
         (user_id, event_id, outcome_id, prev_prob, new_prob, stake_amount, shares_acquired, hold_until)
       VALUES ($1, $2, $3, 0.25, 0.4, 5, 6.0, NOW() - INTERVAL '2 days')`,
      [user.id, resolvedEventId, resolvedOutcomeId]
    );

    // Control: a resolved market the user never traded must NOT appear.
    const untradedEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, outcome, resolved_at)
       VALUES ('Resolved MC untraded', 'x', NOW() - INTERVAL '1 day', 'multiple_choice', 'Beta', NOW())
       RETURNING id`
    );
    const untradedEventId = untradedEvent.rows[0].id;
    cleanup.events.add(untradedEventId);

    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    const rows = res.body;

    const resolvedRow = rows.find((r) => Number(r.event_id) === resolvedEventId);
    expect(resolvedRow).toBeDefined();
    expect(resolvedRow.position_kind).toBe('resolved');
    expect(resolvedRow.outcome).toBe('Alpha');

    const untradedRow = rows.find((r) => Number(r.event_id) === untradedEventId);
    expect(untradedRow).toBeUndefined();
  });

  test('recently-resolved numeric market surfaces via distribution_trades alone', async () => {
    // Numeric (distribution) trades journal into distribution_trades, not
    // market_updates/market_outcome_updates. Settlement deletes
    // user_outcome_shares, so without the distribution_trades disjunct in the
    // resolved-branch EXISTS clause, a resolved numeric market the user only
    // ever traded via numeric-trade would silently vanish from MyPositions.
    const user = await makeUser('positions_resolved_distribution');
    cleanup.users.add(user.id);

    const resolvedEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, outcome, resolved_at)
       VALUES ('Resolved numeric via distribution_trades', 'x', NOW() - INTERVAL '1 day', 'numeric', '42.0', NOW())
       RETURNING id`
    );
    const resolvedEventId = resolvedEvent.rows[0].id;
    cleanup.events.add(resolvedEventId);
    // Trade-history row only — no user_outcome_shares (settlement deleted it),
    // and no market_updates/market_outcome_updates row (this user only ever
    // traded the distribution).
    await db.query(
      `INSERT INTO distribution_trades
         (user_id, event_id, total_cost_ledger, alpha, target_distribution, pre_market_version, post_market_version, hold_until, created_at)
       VALUES ($1, $2, 5000000, 0.5, $3, 0, 1, NULL, NOW() - INTERVAL '2 days')`,
      [user.id, resolvedEventId, JSON.stringify({ bin_0: 1.0 })]
    );

    // Control: a resolved numeric market the user never traded must NOT appear.
    const untradedEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, outcome, resolved_at)
       VALUES ('Resolved numeric untraded', 'x', NOW() - INTERVAL '1 day', 'numeric', '7.0', NOW())
       RETURNING id`
    );
    const untradedEventId = untradedEvent.rows[0].id;
    cleanup.events.add(untradedEventId);

    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    const rows = res.body;

    const resolvedRow = rows.find((r) => Number(r.event_id) === resolvedEventId);
    expect(resolvedRow).toBeDefined();
    expect(resolvedRow.position_kind).toBe('resolved');
    expect(resolvedRow.outcome).toBe('42.0');

    const untradedRow = rows.find((r) => Number(r.event_id) === untradedEventId);
    expect(untradedRow).toBeUndefined();
  });
});
