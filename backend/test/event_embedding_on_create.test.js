const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/services/eventEnrichmentService', () => ({
  enrichEventInBackground: jest.fn()
}));

const { app } = require('../src/index');
const db = require('../src/db');
const eventEnrichment = require('../src/services/eventEnrichmentService');

jest.setTimeout(60000);

const cleanup = { users: new Set(), events: new Set() };

const createUser = async ({ email, username, password, verificationTier = 3 }) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO users (email, username, password_hash, verification_tier, created_at, updated_at, rp_balance_ledger)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), (1000 * 1000000)::bigint)
     RETURNING id`,
    [email, username, passwordHash, verificationTier]
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

const waitForEmbedCall = async (eventId, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = eventEnrichment.enrichEventInBackground.mock.calls.find(
      ([args]) => Number(args?.id) === Number(eventId)
    );
    if (call) return call[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
};

describe('Event embedding on creation', () => {
  beforeEach(() => {
    eventEnrichment.enrichEventInBackground.mockClear();
  });

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

  test('POST /api/events embeds the new event', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createUser({ email: `embed_ev_${ts}@example.com`, username: `embed_ev_${ts}`, password });
    const token = await login(`embed_ev_${ts}@example.com`, password);

    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `Embedding hook event ${ts}`,
        details: 'Will this event get an embedding?',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });

    expect([200, 201]).toContain(res.statusCode);
    const eventId = res.body?.id || res.body?.event?.id;
    expect(eventId).toBeDefined();
    cleanup.events.add(eventId);

    const call = await waitForEmbedCall(eventId);
    expect(call).not.toBeNull();
    expect(call.title).toContain('Embedding hook event');
  });

  test('approved market question submission embeds the created event', async () => {
    const ts = Date.now();
    const password = 'testpass123';

    await createUser({ email: `embed_mq_${ts}@example.com`, username: `embed_mq_${ts}`, password });
    const creatorToken = await login(`embed_mq_${ts}@example.com`, password);

    const createRes = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        title: `Embedding MQ ${ts}`,
        details: 'Will approval embed this?',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });
    expect(createRes.statusCode).toBe(201);
    const submissionId = createRes.body.submission.id;
    const requiredValidators = createRes.body.submission.required_validators;

    for (let i = 0; i < requiredValidators; i += 1) {
      const email = `embed_mq_val_${i}_${ts}@example.com`;
      await createUser({ email, username: `embed_mq_val_${i}_${ts}`, password });
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
    expect(eventId).toBeDefined();
    cleanup.events.add(eventId);

    const call = await waitForEmbedCall(eventId);
    expect(call).not.toBeNull();
    expect(call.title).toContain('Embedding MQ');
  });
});
