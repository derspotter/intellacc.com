const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(60000);

const cleanup = { users: new Set(), events: new Set() };
const LEDGER_SCALE = 1_000_000n;

const createUser = async ({ email, username, password, rpBalanceLedger = 1_000n * LEDGER_SCALE }) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, updated_at, rp_balance_ledger)
     VALUES ($1, $2, $3, NOW(), NOW(), $4::bigint)
     RETURNING id`,
    [email, username, passwordHash, rpBalanceLedger.toString()]
  );
  const id = result.rows[0].id;
  cleanup.users.add(id);
  return id;
};

const login = async (email, password) => {
  const res = await request(app).post('/api/login').send({ email, password });
  expect(res.statusCode).toBe(200);
  return res.body.token;
};

describe('Market question pipeline: multi-outcome submissions', () => {
  afterAll(async () => {
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    if (cleanup.users.size) {
      await db.query(
        'DELETE FROM market_question_submissions WHERE creator_user_id = ANY($1::int[])',
        [Array.from(cleanup.users)]
      );
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
  });

  test('stores normalized multiple_choice outcomes on the submission', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createUser({ email: `mqmc_${ts}@example.com`, username: `mqmc_${ts}`, password });
    const token = await login(`mqmc_${ts}@example.com`, password);

    const res = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `MC question ${ts}`,
        details: 'Which option wins?',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'multiple_choice',
        outcomes: ['Alpha', 'Beta', 'Gamma']
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.submission.event_type).toBe('multiple_choice');
    const rows = res.body.submission.outcome_rows;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ key: 'choice_1', label: 'Alpha', sortOrder: 0 });
  });

  test('rejects multiple_choice submissions with fewer than two outcomes', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createUser({ email: `mqmc_short_${ts}@example.com`, username: `mqmc_short_${ts}`, password });
    const token = await login(`mqmc_short_${ts}@example.com`, password);

    const res = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `MC short ${ts}`,
        details: 'Not enough options',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'multiple_choice',
        outcomes: ['Only one']
      });

    expect(res.statusCode).toBe(400);
  });

  test('rejects overlapping numeric buckets', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createUser({ email: `mqnum_${ts}@example.com`, username: `mqnum_${ts}`, password });
    const token = await login(`mqnum_${ts}@example.com`, password);

    const res = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `Numeric overlap ${ts}`,
        details: 'Buckets overlap',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'numeric',
        numeric_buckets: [
          { lower_bound: 0, upper_bound: 10 },
          { lower_bound: 5, upper_bound: 15 }
        ]
      });

    expect(res.statusCode).toBe(400);
  });

  test('approved multiple_choice submission creates a seeded multi-outcome event', async () => {
    const ts = Date.now();
    const password = 'testpass123';

    await createUser({ email: `mqfin_creator_${ts}@example.com`, username: `mqfin_creator_${ts}`, password });
    const creatorToken = await login(`mqfin_creator_${ts}@example.com`, password);

    const createRes = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        title: `MC finalize ${ts}`,
        details: 'Which option wins?',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'multiple_choice',
        outcomes: ['Alpha', 'Beta']
      });
    expect(createRes.statusCode).toBe(201);
    const submissionId = createRes.body.submission.id;
    const requiredValidators = createRes.body.submission.required_validators;

    for (let i = 0; i < requiredValidators; i += 1) {
      const email = `mqfin_val_${i}_${ts}@example.com`;
      await createUser({ email, username: `mqfin_val_${i}_${ts}`, password });
      const token = await login(email, password);
      const reviewRes = await request(app)
        .post(`/api/market-questions/${submissionId}/reviews`)
        .set('Authorization', `Bearer ${token}`)
        .send({ vote: 'approve' });
      expect([200, 201]).toContain(reviewRes.statusCode);
    }

    const subRes = await db.query(
      'SELECT status, approved_event_id FROM market_question_submissions WHERE id = $1',
      [submissionId]
    );
    expect(subRes.rows[0].status).toBe('approved');
    const eventId = subRes.rows[0].approved_event_id;
    expect(eventId).toBeTruthy();
    cleanup.events.add(eventId);

    const eventRes = await db.query('SELECT event_type FROM events WHERE id = $1', [eventId]);
    expect(eventRes.rows[0].event_type).toBe('multiple_choice');

    const outcomesRes = await db.query(
      'SELECT outcome_key, label FROM event_outcomes WHERE event_id = $1 ORDER BY sort_order',
      [eventId]
    );
    expect(outcomesRes.rows).toHaveLength(2);
    expect(outcomesRes.rows.map((r) => r.label)).toEqual(['Alpha', 'Beta']);

    const statesRes = await db.query(
      'SELECT prob FROM event_outcome_states WHERE event_id = $1',
      [eventId]
    );
    expect(statesRes.rows).toHaveLength(2);
    expect(Number(statesRes.rows[0].prob)).toBeCloseTo(0.5);
  });
});
