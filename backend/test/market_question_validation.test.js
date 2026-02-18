const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const cleanup = {
  users: new Set(),
  events: new Set(),
  marketUpdates: new Set()
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

const createMarketUpdate = async ({ userId, eventId, stakeAmount }) => {
  const prevProb = 0.5;
  const newProb = 0.5001;
  const sharesAcquired = 1;
  const stakeAmountLedger = Math.round(stakeAmount * 1_000_000);
  const result = await db.query(
    `INSERT INTO market_updates
     (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until, stake_amount_ledger)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '1 hour', $8)
     RETURNING id`,
    [
      userId,
      eventId,
      prevProb,
      newProb,
      stakeAmount,
      sharesAcquired,
      'yes',
      stakeAmountLedger
    ]
  );
  cleanup.marketUpdates.add(result.rows[0].id);
};

const createAdminUser = async ({ email, username, password, rpBalanceLedger }) => {
  const id = await createUser({ email, username, password, rpBalanceLedger });
  await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', id]);
  cleanup.users.add(id);
  return id;
};

const createApprovedSubmission = async ({ createdAtSuffix }) => {
  const password = 'testpass123';
  const timestamp = createdAtSuffix || Date.now();

  const creatorId = await createUser({
    email: `mq_auto_creator_${timestamp}@example.com`,
    username: `mq_auto_creator_${timestamp}`,
    password,
    rpBalanceLedger: 1_000n * LEDGER_SCALE
  });

  const creatorToken = await login(`mq_auto_creator_${timestamp}@example.com`, password);
  const createRes = await request(app)
    .post('/api/market-questions')
    .set('Authorization', `Bearer ${creatorToken}`)
    .send({
      title: `Market Question Auto ${timestamp}`,
      details: 'Will this pass automated resolution checks?',
      category: 'product',
      closing_date: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString()
    });

  expect(createRes.statusCode).toBe(201);
  const submissionId = createRes.body.submission.id;

  const validatorEmails = [];
  for (let i = 0; i < 5; i += 1) {
    validatorEmails.push(`mq_auto_validator_${i}_${timestamp}@example.com`);
    await createUser({
      email: validatorEmails[i],
      username: `mq_auto_validator_${i}_${timestamp}`,
      password,
      rpBalanceLedger: 1_000n * LEDGER_SCALE
    });
  }

  for (let i = 0; i < validatorEmails.length; i += 1) {
    const token = await login(validatorEmails[i], password);
    const reviewRes = await request(app)
      .post(`/api/market-questions/${submissionId}/reviews`)
      .set('Authorization', `Bearer ${token}`)
      .send({ vote: 'approve', note: `vote-${i}` });

    expect(reviewRes.statusCode).toBe(200);
    if (i === validatorEmails.length - 1) {
      expect(reviewRes.body.finalized).toBe(true);
      expect(reviewRes.body.approved).toBe(true);
      expect(reviewRes.body.approved_event_id).toBeDefined();
    }
  }

  const approvedEventRes = await request(app)
    .get(`/api/market-questions/${submissionId}`)
    .set('Authorization', `Bearer ${creatorToken}`);
  expect(approvedEventRes.statusCode).toBe(200);
  expect(approvedEventRes.body.submission.status).toBe('approved');

  return {
    submissionId,
    creatorId,
    approvedEventId: Number(approvedEventRes.body.submission.approved_event_id),
    creatorToken
  };
};

describe('Market question submission and validation', () => {
  afterAll(async () => {
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    if (cleanup.users.size) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
    if (cleanup.marketUpdates.size) {
      await db.query('DELETE FROM market_updates WHERE id = ANY($1::int[])', [Array.from(cleanup.marketUpdates)]);
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

  test('automatic market-question reward sweep applies traction and resolution payouts', async () => {
    const ts = Date.now();
    const password = 'testpass123';

    await createAdminUser({
      email: `mq_admin_${ts}@example.com`,
      username: `mq_admin_${ts}`,
      password,
      rpBalanceLedger: 1_000n * LEDGER_SCALE
    });

    const creatorId = await createUser({
      email: `mq_creator_auto_${ts}@example.com`,
      username: `mq_creator_auto_${ts}`,
      password,
      rpBalanceLedger: 1_000n * LEDGER_SCALE
    });

    const validatorIds = [];
    const validatorEmails = [];
    for (let i = 0; i < 5; i += 1) {
      const email = `mq_validator_auto_${i}_${ts}@example.com`;
      validatorEmails.push(email);
      const id = await createUser({
        email,
        username: `mq_validator_auto_${i}_${ts}`,
        password,
        rpBalanceLedger: 1_000n * LEDGER_SCALE
      });
      validatorIds.push(id);
    }

    const bettorIds = [];
    for (let i = 0; i < 5; i += 1) {
      const email = `mq_bettor_auto_${i}_${ts}@example.com`;
      const id = await createUser({
        email,
        username: `mq_bettor_auto_${i}_${ts}`,
        password,
        rpBalanceLedger: 1_000n * LEDGER_SCALE
      });
      bettorIds.push(id);
    }

    const creatorToken = await login(`mq_creator_auto_${ts}@example.com`, password);
    const createRes = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        title: `Market Question Auto ${ts}`,
        details: 'Will feature X reach milestone by date Y?',
        category: 'product',
        closing_date: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString()
      });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.body.submission).toBeTruthy();
    expect(createRes.body.submission.id).toBeDefined();

    const submissionId = createRes.body.submission.id;
    for (let i = 0; i < validatorEmails.length; i += 1) {
      const token = await login(validatorEmails[i], password);
      const reviewRes = await request(app)
        .post(`/api/market-questions/${submissionId}/reviews`)
        .set('Authorization', `Bearer ${token}`)
        .send({ vote: 'approve', note: `vote-${i}` });

      expect(reviewRes.statusCode).toBe(200);
    }

    const approvedEventRes = await request(app)
      .get(`/api/market-questions/${submissionId}`)
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(approvedEventRes.statusCode).toBe(200);
    expect(approvedEventRes.body.submission.status).toBe('approved');
    expect(approvedEventRes.body.submission.approved_event_id).toBeDefined();


    const approvedEventId = approvedEventRes.body.submission.approved_event_id;
    cleanup.events.add(approvedEventId);

    for (let i = 0; i < 5; i += 1) {
      const userId = validatorIds[i];
      await createMarketUpdate({
        userId,
        eventId: approvedEventId,
        stakeAmount: 1
      });
    }

    for (let i = 0; i < bettorIds.length; i += 1) {
      await createMarketUpdate({
        userId: bettorIds[i],
        eventId: approvedEventId,
        stakeAmount: 1
      });
    }

    const adminToken = await login(`mq_admin_${ts}@example.com`, password);

    const rewardRunRes = await request(app)
      .post('/api/market-questions/rewards/run')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rewardRunRes.statusCode).toBe(200);
    expect(rewardRunRes.body.success).toBe(true);
    expect(rewardRunRes.body.traction_rewarded).toBe(1);
    expect(rewardRunRes.body.resolution_rewarded).toBe(0);

    const creatorBalanceAfterTraction = await getBalanceLedger(creatorId);
    expect(creatorBalanceAfterTraction).toBe(1_020n * LEDGER_SCALE);

    await db.query('UPDATE events SET outcome = $1 WHERE id = $2', ['yes', approvedEventId]);

    const rewardRunResolutionRes = await request(app)
      .post('/api/market-questions/rewards/run')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rewardRunResolutionRes.statusCode).toBe(200);
    expect(rewardRunResolutionRes.body.success).toBe(true);
    expect(rewardRunResolutionRes.body.resolution_rewarded).toBe(1);

    const creatorBalanceAfterResolution = await getBalanceLedger(creatorId);
    expect(creatorBalanceAfterResolution).toBe(1_030n * LEDGER_SCALE);
  });

  test('automatic market-question reward sweep reports unresolved-linked markets as skipped for resolution', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createAdminUser({
      email: `mq_admin_unresolved_${ts}@example.com`,
      username: `mq_admin_unresolved_${ts}`,
      password,
      rpBalanceLedger: 1_000n * LEDGER_SCALE
    });

    const { submissionId, approvedEventId } = await createApprovedSubmission({ createdAtSuffix: ts });
    cleanup.events.add(approvedEventId);

    const bettorIds = [];
    for (let i = 0; i < 10; i += 1) {
      const id = await createUser({
        email: `mq_bettor_unresolved_${i}_${ts}@example.com`,
        username: `mq_bettor_unresolved_${i}_${ts}`,
        password,
        rpBalanceLedger: 1_000n * LEDGER_SCALE
      });
      bettorIds.push(id);
    }

    for (let i = 0; i < bettorIds.length; i += 1) {
      await createMarketUpdate({
        userId: bettorIds[i],
        eventId: approvedEventId,
        stakeAmount: 1
      });
    }

    const adminToken = await login(`mq_admin_unresolved_${ts}@example.com`, password);
    const rewardRunRes = await request(app)
      .post('/api/market-questions/rewards/run')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rewardRunRes.statusCode).toBe(200);
    expect(rewardRunRes.body.success).toBe(true);
    expect(rewardRunRes.body.processed).toBeGreaterThanOrEqual(1);
    expect(rewardRunRes.body.traction_rewarded).toBeGreaterThanOrEqual(1);
    expect(rewardRunRes.body.resolution_rewarded).toBe(0);
    expect(rewardRunRes.body.resolution_skipped_unresolved).toBeGreaterThanOrEqual(1);

    const summary = rewardRunRes.body.results.find((item) => Number(item.submission_id) === Number(submissionId));
    expect(summary).toBeTruthy();
    expect(summary.resolution_rewarded).toBe(false);
    expect(summary.resolution_reason).toBe('unresolved');
    expect(summary.traction_rewarded).toBe(true);

    const submissionState = await db.query(
      'SELECT creator_resolution_reward_paid, creator_traction_reward_paid FROM market_question_submissions WHERE id = $1',
      [submissionId]
    );
    expect(submissionState.rows[0].creator_resolution_reward_paid).toBe(false);
    expect(submissionState.rows[0].creator_traction_reward_paid).toBe(true);

  });

  test('manual resolution reward rejects unresolved linked events', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createAdminUser({
      email: `mq_admin_unresolved_manual_${ts}@example.com`,
      username: `mq_admin_unresolved_manual_${ts}`,
      password,
      rpBalanceLedger: 1_000n * LEDGER_SCALE
    });

    const { submissionId, approvedEventId } = await createApprovedSubmission({ createdAtSuffix: ts });
    cleanup.events.add(approvedEventId);

    const adminToken = await login(`mq_admin_unresolved_manual_${ts}@example.com`, password);
    const rewardRes = await request(app)
      .post(`/api/market-questions/${submissionId}/rewards/resolution`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rewardRes.statusCode).toBe(409);
    expect(rewardRes.body.message).toBe('Linked event is not resolved yet');

    const afterRes = await db.query(
      'SELECT creator_resolution_reward_paid FROM market_question_submissions WHERE id = $1',
      [submissionId]
    );
    expect(afterRes.rows[0].creator_resolution_reward_paid).toBe(false);
  });

  test('manual resolution reward rejects pending outcome events', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createAdminUser({
      email: `mq_admin_pending_${ts}@example.com`,
      username: `mq_admin_pending_${ts}`,
      password,
      rpBalanceLedger: 1_000n * LEDGER_SCALE
    });

    const { submissionId, approvedEventId } = await createApprovedSubmission({ createdAtSuffix: ts });
    cleanup.events.add(approvedEventId);

    await db.query('UPDATE events SET outcome = $1 WHERE id = $2', ['pending', approvedEventId]);

    const adminToken = await login(`mq_admin_pending_${ts}@example.com`, password);
    const rewardRes = await request(app)
      .post(`/api/market-questions/${submissionId}/rewards/resolution`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rewardRes.statusCode).toBe(409);
    expect(rewardRes.body.message).toBe('Linked event is not resolved yet');
  });
});
