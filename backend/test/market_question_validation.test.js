const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const cleanup = {
  users: new Set(),
  events: new Set()
};

const LEDGER_SCALE = 1_000_000n;

const createUser = async ({ email, username, password, rpBalanceLedger = 1_000_000_000n }) => {
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
  expect(res.body.token).toBeDefined();
  return res.body.token;
};

const getBalanceLedger = async (userId) => {
  const result = await db.query('SELECT rp_balance_ledger FROM users WHERE id = $1', [userId]);
  return BigInt(result.rows[0].rp_balance_ledger || 0);
};

describe('Market question submission and validation', () => {
  afterAll(async () => {
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    if (cleanup.users.size) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
  });

  test('5 validators with 4/5 approval publishes market and settles payouts', async () => {
    const ts = Date.now();
    const password = 'testpass123';

    const creatorId = await createUser({
      email: `mq_creator_${ts}@example.com`,
      username: `mq_creator_${ts}`,
      password,
      rpBalanceLedger: 1_000n * LEDGER_SCALE
    });

    const validatorIds = [];
    const validatorEmails = [];
    for (let i = 0; i < 5; i += 1) {
      const email = `mq_validator_${i}_${ts}@example.com`;
      validatorEmails.push(email);
      const id = await createUser({
        email,
        username: `mq_validator_${i}_${ts}`,
        password,
        rpBalanceLedger: 1_000n * LEDGER_SCALE
      });
      validatorIds.push(id);
    }

    const creatorToken = await login(`mq_creator_${ts}@example.com`, password);
    const createRes = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        title: `Market Question ${ts}`,
        details: 'Will feature X ship before date Y?',
        category: 'product',
        closing_date: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString()
      });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.body.submission).toBeTruthy();
    expect(createRes.body.submission.status).toBe('pending');
    expect(createRes.body.creator_bond_rp).toBe(10);

    const submissionId = createRes.body.submission.id;
    const creatorBalanceAfterBond = await getBalanceLedger(creatorId);
    expect(creatorBalanceAfterBond).toBe(990n * LEDGER_SCALE);

    let finalReviewResponse = null;
    for (let i = 0; i < validatorEmails.length; i += 1) {
      const token = await login(validatorEmails[i], password);
      const vote = i < 4 ? 'approve' : 'reject';
      const reviewRes = await request(app)
        .post(`/api/market-questions/${submissionId}/reviews`)
        .set('Authorization', `Bearer ${token}`)
        .send({ vote, note: `vote-${i}` });

      expect(reviewRes.statusCode).toBe(200);
      if (i < 4) {
        expect(reviewRes.body.finalized).toBe(false);
      } else {
        finalReviewResponse = reviewRes;
      }
    }

    expect(finalReviewResponse).toBeTruthy();
    expect(finalReviewResponse.body.finalized).toBe(true);
    expect(finalReviewResponse.body.approved).toBe(true);
    expect(finalReviewResponse.body.approved_event_id).toBeDefined();
    cleanup.events.add(finalReviewResponse.body.approved_event_id);

    const creatorFinalBalance = await getBalanceLedger(creatorId);
    expect(creatorFinalBalance).toBe(1_010n * LEDGER_SCALE);

    for (let i = 0; i < validatorIds.length; i += 1) {
      const balance = await getBalanceLedger(validatorIds[i]);
      if (i < 4) {
        expect(balance).toBe(1_003n * LEDGER_SCALE);
      } else {
        expect(balance).toBe(998n * LEDGER_SCALE);
      }
    }

    const submissionRow = await db.query(
      'SELECT status, approvals, rejections, approved_event_id FROM market_question_submissions WHERE id = $1',
      [submissionId]
    );
    expect(submissionRow.rows[0].status).toBe('approved');
    expect(Number(submissionRow.rows[0].approvals)).toBe(4);
    expect(Number(submissionRow.rows[0].rejections)).toBe(1);
    expect(submissionRow.rows[0].approved_event_id).toBe(finalReviewResponse.body.approved_event_id);
  });
});
