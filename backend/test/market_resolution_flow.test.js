const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(60000);

const LEDGER_SCALE = 1_000_000n;
const PROPOSER_STAKE = 50n * LEDGER_SCALE;
const PROPOSER_REWARD = 10n * LEDGER_SCALE;
const VOTER_STAKE = 10n * LEDGER_SCALE;
const VOTER_PAYOUT = 25n * LEDGER_SCALE;

const cleanup = {
  users: new Set(),
  events: new Set(),
  marketUpdates: new Set()
};

const uniq = () => `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

const createUser = async ({ activeDaysAgo = 0, rpBalanceLedger = 1_000n * LEDGER_SCALE } = {}) => {
  const tag = uniq();
  const passwordHash = await bcrypt.hash('password123', 10);
  const result = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, updated_at, rp_balance_ledger, last_active_at)
     VALUES ($1, $2, $3, NOW(), NOW(), $4::bigint, NOW() - ($5 || ' days')::interval)
     RETURNING id`,
    [`res_${tag}@example.com`, `res_${tag}`, passwordHash, rpBalanceLedger.toString(), String(activeDaysAgo)]
  );
  const id = result.rows[0].id;
  cleanup.users.add(id);
  return { id, email: `res_${tag}@example.com` };
};

const login = async (email) => {
  const res = await request(app).post('/api/login').send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  return res.body.token;
};

const createClosedEvent = async () => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date)
     VALUES ($1, 'resolution flow test', NOW() - INTERVAL '1 day') RETURNING id`,
    [`Resolution flow market ${uniq()}`]
  );
  cleanup.events.add(result.rows[0].id);
  return result.rows[0].id;
};

const createOpenEvent = async () => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date)
     VALUES ($1, 'resolution flow test', NOW() + INTERVAL '30 days') RETURNING id`,
    [`Resolution flow market ${uniq()}`]
  );
  cleanup.events.add(result.rows[0].id);
  return result.rows[0].id;
};

const addTrade = async (userId, eventId) => {
  const result = await db.query(
    `INSERT INTO market_updates
     (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until, stake_amount_ledger)
     VALUES ($1, $2, 0.5, 0.5001, 1, 1, 'yes', NOW() + INTERVAL '1 hour', 1000000)
     RETURNING id`,
    [userId, eventId]
  );
  cleanup.marketUpdates.add(result.rows[0].id);
};

const getBalance = async (userId) => {
  const r = await db.query('SELECT rp_balance_ledger FROM users WHERE id = $1', [userId]);
  return BigInt(r.rows[0].rp_balance_ledger || 0);
};

const getProposal = async (proposalId) => {
  const r = await db.query('SELECT * FROM market_resolution_proposals WHERE id = $1', [proposalId]);
  return r.rows[0];
};

const propose = (token, eventId, body = {}) =>
  request(app)
    .post(`/api/events/${eventId}/resolution-proposals`)
    .set('Authorization', `Bearer ${token}`)
    .send({ outcome: 'yes', source_url: 'https://example.com/proof', ...body });

const vote = (token, proposalId, voteValue) =>
  request(app)
    .post(`/api/resolution-proposals/${proposalId}/votes`)
    .set('Authorization', `Bearer ${token}`)
    .send({ vote: voteValue });

// Standard scene: closed market, a proposer, and enough active bystanders to
// form a jury. Stales out users from earlier tests first so this scene's
// users are the only eligible jurors (the DB is shared across tests).
const buildScene = async ({ bystanders = 4 } = {}) => {
  if (cleanup.users.size) {
    await db.query(
      "UPDATE users SET last_active_at = NOW() - INTERVAL '30 days' WHERE id = ANY($1::int[])",
      [Array.from(cleanup.users)]
    );
  }
  const eventId = await createClosedEvent();
  const proposer = await createUser();
  const others = [];
  for (let i = 0; i < bystanders; i++) {
    others.push(await createUser());
  }
  return { eventId, proposer, others };
};

describe('Community market resolution flow', () => {
  afterAll(async () => {
    if (cleanup.marketUpdates.size) {
      await db.query('DELETE FROM market_updates WHERE id = ANY($1::int[])', [Array.from(cleanup.marketUpdates)]);
    }
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    if (cleanup.users.size) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
    await db.getPool().end();
  });

  test('proposing on a closed market stakes 5 RP and draws a jury of eligible users', async () => {
    const { eventId, proposer, others } = await buildScene();
    const token = await login(proposer.email);
    const before = await getBalance(proposer.id);

    const res = await propose(token, eventId);
    expect(res.statusCode).toBe(201);
    expect(res.body.proposal.status).toBe('voting');

    expect(await getBalance(proposer.id)).toBe(before - PROPOSER_STAKE);

    const jurors = await db.query(
      'SELECT user_id FROM market_resolution_jurors WHERE proposal_id = $1',
      [res.body.proposal.id]
    );
    const jurorIds = jurors.rows.map((r) => r.user_id);
    expect(jurorIds).not.toContain(proposer.id);
    // All active bystanders get a seat (pool smaller than the draw cap).
    for (const o of others) {
      expect(jurorIds).toContain(o.id);
    }
  });

  test('rejects proposals on markets that have not closed yet', async () => {
    const eventId = await createOpenEvent();
    const proposer = await createUser();
    const token = await login(proposer.email);
    const res = await propose(token, eventId);
    expect(res.statusCode).toBe(400);
  });

  test('rejects proposals from users holding a position in the market', async () => {
    const { eventId, proposer } = await buildScene({ bystanders: 0 });
    await addTrade(proposer.id, eventId);
    const token = await login(proposer.email);
    const res = await propose(token, eventId);
    expect(res.statusCode).toBe(403);
  });

  test('users who traded the market are excluded from the jury', async () => {
    const { eventId, proposer, others } = await buildScene();
    await addTrade(others[0].id, eventId);
    const token = await login(proposer.email);

    const res = await propose(token, eventId);
    expect(res.statusCode).toBe(201);

    const jurors = await db.query(
      'SELECT user_id FROM market_resolution_jurors WHERE proposal_id = $1',
      [res.body.proposal.id]
    );
    expect(jurors.rows.map((r) => r.user_id)).not.toContain(others[0].id);
  });

  test('users inactive for more than 7 days are excluded from the jury', async () => {
    const { eventId, proposer, others } = await buildScene({ bystanders: 3 });
    const stale = await createUser({ activeDaysAgo: 10 });
    const token = await login(proposer.email);

    const res = await propose(token, eventId);
    expect(res.statusCode).toBe(201);

    const jurors = await db.query(
      'SELECT user_id FROM market_resolution_jurors WHERE proposal_id = $1',
      [res.body.proposal.id]
    );
    expect(jurors.rows.map((r) => r.user_id)).not.toContain(stale.id);
  });

  test('only drawn jurors can vote; a juror vote stakes 2 RP', async () => {
    const { eventId, proposer, others } = await buildScene();
    const outsider = await createUser({ activeDaysAgo: 20 });
    const proposalRes = await propose(await login(proposer.email), eventId);
    const proposalId = proposalRes.body.proposal.id;

    const outsiderRes = await vote(await login(outsider.email), proposalId, 'confirm');
    expect(outsiderRes.statusCode).toBe(403);

    const juror = others[0];
    const before = await getBalance(juror.id);
    const jurorRes = await vote(await login(juror.email), proposalId, 'confirm');
    expect(jurorRes.statusCode).toBe(201);
    expect(await getBalance(juror.id)).toBe(before - VOTER_STAKE);
  });

  test('third confirm moves the proposal into the 24h challenge window', async () => {
    const { eventId, proposer, others } = await buildScene();
    const proposalRes = await propose(await login(proposer.email), eventId);
    const proposalId = proposalRes.body.proposal.id;

    for (let i = 0; i < 3; i++) {
      const res = await vote(await login(others[i].email), proposalId, 'confirm');
      expect(res.statusCode).toBe(201);
    }

    const proposal = await getProposal(proposalId);
    expect(proposal.status).toBe('challenge_window');
    expect(proposal.challenge_ends_at).not.toBeNull();
  });

  test('two rejects escalate the proposal to admin', async () => {
    const { eventId, proposer, others } = await buildScene();
    const proposalRes = await propose(await login(proposer.email), eventId);
    const proposalId = proposalRes.body.proposal.id;

    await vote(await login(others[0].email), proposalId, 'reject');
    await vote(await login(others[1].email), proposalId, 'reject');

    const proposal = await getProposal(proposalId);
    expect(proposal.status).toBe('escalated');
    expect(proposal.escalation_reason).toBe('disputed');
  });

  test('a challenge during the window escalates instead of settling', async () => {
    const { eventId, proposer, others } = await buildScene();
    const proposalRes = await propose(await login(proposer.email), eventId);
    const proposalId = proposalRes.body.proposal.id;
    for (let i = 0; i < 3; i++) {
      await vote(await login(others[i].email), proposalId, 'confirm');
    }

    const challenger = others[3];
    const res = await request(app)
      .post(`/api/resolution-proposals/${proposalId}/challenge`)
      .set('Authorization', `Bearer ${await login(challenger.email)}`)
      .send({ note: 'source does not support this' });
    expect(res.statusCode).toBe(200);

    const proposal = await getProposal(proposalId);
    expect(proposal.status).toBe('escalated');
    expect(proposal.escalation_reason).toBe('challenged');
  });

  test('sweep settles a proposal whose challenge window has passed: market resolves, jurors and proposer paid', async () => {
    const { eventId, proposer, others } = await buildScene();
    const proposalRes = await propose(await login(proposer.email), eventId);
    const proposalId = proposalRes.body.proposal.id;
    for (let i = 0; i < 3; i++) {
      await vote(await login(others[i].email), proposalId, 'confirm');
    }
    await db.query(
      "UPDATE market_resolution_proposals SET challenge_ends_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [proposalId]
    );

    const proposerBefore = await getBalance(proposer.id);
    const jurorBefore = await getBalance(others[0].id);

    const controller = require('../src/controllers/marketResolutionController');
    const result = await controller.sweepDueProposals();
    expect(result.settled).toBeGreaterThanOrEqual(1);

    const proposal = await getProposal(proposalId);
    expect(proposal.status).toBe('confirmed');

    const event = await db.query('SELECT outcome FROM events WHERE id = $1', [eventId]);
    expect(event.rows[0].outcome).toBe('yes');

    // Proposer gets the stake back plus the confirmation reward; a
    // confirming juror gets the winning payout (stake included).
    expect(await getBalance(proposer.id)).toBe(proposerBefore + PROPOSER_STAKE + PROPOSER_REWARD);
    expect(await getBalance(others[0].id)).toBe(jurorBefore + VOTER_PAYOUT);
  });

  test('sweep escalates proposals that never reached quorum before the voting deadline', async () => {
    const { eventId, proposer } = await buildScene({ bystanders: 4 });
    const proposalRes = await propose(await login(proposer.email), eventId);
    const proposalId = proposalRes.body.proposal.id;
    await db.query(
      "UPDATE market_resolution_proposals SET voting_deadline_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [proposalId]
    );

    const controller = require('../src/controllers/marketResolutionController');
    await controller.sweepDueProposals();

    const proposal = await getProposal(proposalId);
    expect(proposal.status).toBe('escalated');
    expect(proposal.escalation_reason).toBe('timeout');
  });

  test('admin ruling against the proposal forfeits the proposer stake and pays reject voters', async () => {
    const { eventId, proposer, others } = await buildScene();
    const proposalRes = await propose(await login(proposer.email), eventId);
    const proposalId = proposalRes.body.proposal.id;
    await vote(await login(others[0].email), proposalId, 'reject');
    await vote(await login(others[1].email), proposalId, 'reject');

    const admin = await createUser();
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);
    const proposerBefore = await getBalance(proposer.id);
    const rejectorBefore = await getBalance(others[0].id);

    const res = await request(app)
      .post(`/api/resolution-proposals/${proposalId}/admin-ruling`)
      .set('Authorization', `Bearer ${await login(admin.email)}`)
      .send({ outcome: 'no' });
    expect(res.statusCode).toBe(200);

    const proposal = await getProposal(proposalId);
    expect(proposal.status).toBe('overturned');

    const event = await db.query('SELECT outcome FROM events WHERE id = $1', [eventId]);
    expect(event.rows[0].outcome).toBe('no');

    // Proposer stake gone; reject voter gets the winning payout.
    expect(await getBalance(proposer.id)).toBe(proposerBefore);
    expect(await getBalance(others[0].id)).toBe(rejectorBefore + VOTER_PAYOUT);
  });

  test('a proposer overturned within 7 days cannot propose again', async () => {
    const { eventId, proposer, others } = await buildScene();
    const token = await login(proposer.email);
    const proposalRes = await propose(token, eventId);
    await vote(await login(others[0].email), proposalRes.body.proposal.id, 'reject');
    await vote(await login(others[1].email), proposalRes.body.proposal.id, 'reject');

    const admin = await createUser();
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);
    await request(app)
      .post(`/api/resolution-proposals/${proposalRes.body.proposal.id}/admin-ruling`)
      .set('Authorization', `Bearer ${await login(admin.email)}`)
      .send({ outcome: 'no' });

    const secondEvent = await createClosedEvent();
    const res = await propose(token, secondEvent);
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/cooldown/i);
  });
});
