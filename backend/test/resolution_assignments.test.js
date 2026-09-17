const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');
const assignmentService = require('../src/services/resolutionAssignmentService');

jest.setTimeout(60000);

const LEDGER_SCALE = 1_000_000n;
const RICH = 1_000n * LEDGER_SCALE;

const cleanup = { users: new Set(), events: new Set() };

const uniq = () => `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

const createUser = async ({ activeDaysAgo = 0, rpBalanceLedger = RICH } = {}) => {
  const tag = uniq();
  const passwordHash = await bcrypt.hash('password123', 10);
  const result = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, updated_at, rp_balance_ledger, last_active_at)
     VALUES ($1, $2, $3, NOW(), NOW(), $4::bigint, NOW() - ($5 || ' days')::interval)
     RETURNING id`,
    [`asg_${tag}@example.com`, `asg_${tag}`, passwordHash, rpBalanceLedger.toString(), String(activeDaysAgo)]
  );
  const id = result.rows[0].id;
  cleanup.users.add(id);
  return { id, email: `asg_${tag}@example.com` };
};

const login = async (email) => {
  const res = await request(app).post('/api/login').send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  return res.body.token;
};

const createClosedEvent = async (overrides = {}) => {
  const { eventType = 'binary', closingOffset = "- INTERVAL '1 day'" } = overrides;
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type)
     VALUES ($1, 'resolution assignment test', NOW() ${closingOffset}, $2) RETURNING id`,
    [`Assignment market ${uniq()}`, eventType]
  );
  cleanup.events.add(result.rows[0].id);
  return result.rows[0].id;
};

// The draw is global ("every recently active, uninvolved user"), so a shared
// database would otherwise seat real accounts. Same trick the jury-flow suite
// uses: a zero-share position makes everyone outside the scene "involved" in
// this throwaway market, which the draw already excludes. Nothing global is
// touched and the rows cascade away with the event.
const isolatePool = async (eventId, sceneUserIds) => {
  await db.query(
    `INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares)
     SELECT u.id, $1, 0, 0 FROM users u
     WHERE u.deleted_at IS NULL AND NOT (u.id = ANY($2::int[]))
     ON CONFLICT (user_id, event_id) DO NOTHING`,
    [eventId, sceneUserIds]
  );
};

const buildScene = async ({ candidates = 1, candidateOpts = {} } = {}) => {
  const eventId = await createClosedEvent();
  const users = [];
  for (let i = 0; i < candidates; i++) {
    users.push(await createUser(candidateOpts));
  }
  await isolatePool(eventId, users.map((u) => u.id));
  return { eventId, users };
};

// Every sweep in this suite is scoped to the scene's markets so concurrent
// scenes (and any other data in the database) cannot interfere.
const sweep = (eventIds) => assignmentService.runAssignmentSweep({ eventIds });

const assignmentsFor = async (eventId) => {
  const res = await db.query(
    'SELECT * FROM market_resolution_assignments WHERE event_id = $1 ORDER BY id',
    [eventId]
  );
  return res.rows;
};

const pendingFor = async (eventId) => (await assignmentsFor(eventId)).filter((a) => a.status === 'pending');

describe('Random resolution proposer assignments', () => {
  afterAll(async () => {
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    if (cleanup.users.size) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
    await db.getPool().end();
  });

  test('assigns a closed, unresolved, visible binary market to an eligible user', async () => {
    const { eventId, users } = await buildScene({ candidates: 2 });

    const stats = await sweep([eventId]);
    expect(stats.assigned).toBe(1);

    const pending = await pendingFor(eventId);
    expect(pending).toHaveLength(1);
    expect(users.map((u) => u.id)).toContain(pending[0].user_id);
    // 72h default window.
    const hours = (new Date(pending[0].expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThan(73);
  });

  test('a second sweep does not add a second assignment to the same market', async () => {
    const { eventId } = await buildScene({ candidates: 3 });
    await sweep([eventId]);
    const stats = await sweep([eventId]);
    expect(stats.assigned).toBe(0);
    expect(await pendingFor(eventId)).toHaveLength(1);
  });

  test('skips markets that are open, resolved, hidden or non-binary', async () => {
    const openId = await createClosedEvent({ closingOffset: "+ INTERVAL '30 days'" });
    const resolvedId = await createClosedEvent();
    const hiddenId = await createClosedEvent();
    const numericId = await createClosedEvent({ eventType: 'numeric' });
    const user = await createUser();
    for (const id of [openId, resolvedId, hiddenId, numericId]) {
      await isolatePool(id, [user.id]);
    }
    await db.query("UPDATE events SET outcome = 'yes' WHERE id = $1", [resolvedId]);
    await db.query('UPDATE events SET hidden_at = NOW() WHERE id = $1', [hiddenId]);

    const stats = await sweep([openId, resolvedId, hiddenId, numericId]);
    expect(stats.assigned).toBe(0);
    for (const id of [openId, resolvedId, hiddenId, numericId]) {
      expect(await assignmentsFor(id)).toHaveLength(0);
    }
  });

  test('skips markets that already have an active resolution proposal', async () => {
    const { eventId, users } = await buildScene({ candidates: 2 });
    const proposer = users[0];
    await db.query(
      `INSERT INTO market_resolution_proposals
        (event_id, proposer_user_id, proposed_outcome, source_url, proposer_stake_ledger, jury_size, voting_deadline_at)
       VALUES ($1, $2, 'yes', 'https://example.com/p', 0, 0, NOW() + INTERVAL '3 days')`,
      [eventId, proposer.id]
    );

    const stats = await sweep([eventId]);
    expect(stats.assigned).toBe(0);
    expect(await assignmentsFor(eventId)).toHaveLength(0);
  });

  test('never draws involved, stale, deleted, broke or cooled-down users', async () => {
    const eventId = await createClosedEvent();
    const involved = await createUser();
    const stale = await createUser({ activeDaysAgo: 30 });
    const deleted = await createUser();
    const broke = await createUser({ rpBalanceLedger: 49n * LEDGER_SCALE });
    const cooled = await createUser();
    const eligible = await createUser();
    await isolatePool(eventId, [involved.id, stale.id, deleted.id, broke.id, cooled.id, eligible.id]);

    await db.query(
      `INSERT INTO predictions (user_id, event_id, event, prediction_value, confidence)
       VALUES ($1, $2, 'involved', 'yes', 60)`,
      [involved.id, eventId]
    );
    await db.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [deleted.id]);
    const otherEvent = await createClosedEvent();
    await db.query(
      `INSERT INTO market_resolution_proposals
        (event_id, proposer_user_id, proposed_outcome, source_url, proposer_stake_ledger,
         jury_size, voting_deadline_at, status, decided_at)
       VALUES ($1, $2, 'yes', 'https://example.com/p', 0, 0, NOW(), 'overturned', NOW() - INTERVAL '1 day')`,
      [otherEvent, cooled.id]
    );

    const stats = await sweep([eventId]);
    expect(stats.assigned).toBe(1);
    const pending = await pendingFor(eventId);
    expect(pending).toHaveLength(1);
    expect(pending[0].user_id).toBe(eligible.id);
  });

  test('caps a user at three live assignments and leaves the extra market unassigned', async () => {
    const user = await createUser();
    const eventIds = [];
    for (let i = 0; i < 4; i++) {
      const eventId = await createClosedEvent();
      await isolatePool(eventId, [user.id]);
      eventIds.push(eventId);
    }

    const stats = await sweep(eventIds);
    expect(stats.assigned).toBe(3);
    expect(stats.unassigned).toBe(1);

    const mine = await db.query(
      "SELECT COUNT(*)::int AS n FROM market_resolution_assignments WHERE user_id = $1 AND status = 'pending'",
      [user.id]
    );
    expect(mine.rows[0].n).toBe(3);
  });

  test('a market with no eligible user stays unassigned and is picked up by a later sweep', async () => {
    const eventId = await createClosedEvent();
    await isolatePool(eventId, []);

    const first = await sweep([eventId]);
    expect(first.assigned).toBe(0);
    expect(first.unassigned).toBe(1);
    expect(await assignmentsFor(eventId)).toHaveLength(0);

    const latecomer = await createUser();
    await isolatePool(eventId, [latecomer.id]);

    const second = await sweep([eventId]);
    expect(second.assigned).toBe(1);
    expect((await pendingFor(eventId))[0].user_id).toBe(latecomer.id);
  });

  test('expiry reassigns to someone else and excludes the lapsed user for the same market', async () => {
    const { eventId, users } = await buildScene({ candidates: 2 });
    await sweep([eventId]);
    const first = (await pendingFor(eventId))[0];

    await db.query(
      "UPDATE market_resolution_assignments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [first.id]
    );

    const stats = await sweep([eventId]);
    expect(stats.expired).toBe(1);
    expect(stats.assigned).toBe(1);

    const rows = await assignmentsFor(eventId);
    expect(rows.find((r) => r.id === first.id).status).toBe('expired');
    const pending = rows.filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].user_id).not.toBe(first.user_id);

    // Only one other candidate existed, so letting that one lapse too leaves
    // the market unassigned rather than recycling the excluded user.
    await db.query(
      "UPDATE market_resolution_assignments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [pending[0].id]
    );
    const third = await sweep([eventId]);
    expect(third.expired).toBe(1);
    expect(third.assigned).toBe(0);
    expect(users).toHaveLength(2);
  });

  test('maintenance cancels assignments whose market was resolved, hidden or proposed on', async () => {
    const resolved = await buildScene({ candidates: 1 });
    const hidden = await buildScene({ candidates: 1 });
    const proposed = await buildScene({ candidates: 2 });
    const scenes = [resolved, hidden, proposed];
    for (const scene of scenes) {
      await sweep([scene.eventId]);
      expect(await pendingFor(scene.eventId)).toHaveLength(1);
    }

    await db.query("UPDATE events SET outcome = 'yes' WHERE id = $1", [resolved.eventId]);
    await db.query('UPDATE events SET hidden_at = NOW() WHERE id = $1', [hidden.eventId]);
    await db.query(
      `INSERT INTO market_resolution_proposals
        (event_id, proposer_user_id, proposed_outcome, source_url, proposer_stake_ledger, jury_size, voting_deadline_at)
       VALUES ($1, $2, 'yes', 'https://example.com/p', 0, 0, NOW() + INTERVAL '3 days')`,
      [proposed.eventId, proposed.users[1].id]
    );

    const stats = await sweep(scenes.map((s) => s.eventId));
    expect(stats.cancelled).toBe(3);
    for (const scene of scenes) {
      expect(await pendingFor(scene.eventId)).toHaveLength(0);
      expect((await assignmentsFor(scene.eventId))[0].status).toBe('cancelled');
    }
  });

  test('maintenance revokes an assignment once the assignee becomes involved in the market', async () => {
    const { eventId, users } = await buildScene({ candidates: 2 });
    await sweep([eventId]);
    const assigned = (await pendingFor(eventId))[0];

    await db.query(
      `INSERT INTO predictions (user_id, event_id, event, prediction_value, confidence)
       VALUES ($1, $2, 'traded after assignment', 'yes', 55)`,
      [assigned.user_id, eventId]
    );

    const stats = await sweep([eventId]);
    expect(stats.cancelled).toBe(1);
    expect(stats.assigned).toBe(1);
    const pending = await pendingFor(eventId);
    expect(pending[0].user_id).not.toBe(assigned.user_id);
    expect(users.map((u) => u.id)).toContain(pending[0].user_id);
  });

  describe('assignment queue and decline endpoints', () => {
    test('GET /assignment-queue returns the caller\'s live assignments only', async () => {
      const { eventId, users } = await buildScene({ candidates: 1 });
      await sweep([eventId]);
      const assignee = users[0];
      const bystander = await createUser();

      const res = await request(app)
        .get('/api/resolution-proposals/assignment-queue')
        .set('Authorization', `Bearer ${await login(assignee.email)}`);
      expect(res.statusCode).toBe(200);
      const row = res.body.find((r) => r.event_id === eventId);
      expect(row).toBeDefined();
      expect(Object.keys(row).sort()).toEqual(['event_id', 'event_title', 'expires_at', 'id']);
      expect(typeof row.event_title).toBe('string');

      const other = await request(app)
        .get('/api/resolution-proposals/assignment-queue')
        .set('Authorization', `Bearer ${await login(bystander.email)}`);
      expect(other.statusCode).toBe(200);
      expect(other.body.some((r) => r.event_id === eventId)).toBe(false);
    });

    test('the queue requires authentication', async () => {
      const res = await request(app).get('/api/resolution-proposals/assignment-queue');
      expect(res.statusCode).toBe(401);
    });

    test('declining releases the market to another user and is owner-only', async () => {
      const { eventId, users } = await buildScene({ candidates: 2 });
      await sweep([eventId]);
      const assignment = (await pendingFor(eventId))[0];
      const owner = users.find((u) => u.id === assignment.user_id);
      const stranger = users.find((u) => u.id !== assignment.user_id);

      const forbidden = await request(app)
        .post(`/api/resolution-proposals/assignments/${assignment.id}/decline`)
        .set('Authorization', `Bearer ${await login(stranger.email)}`);
      expect(forbidden.statusCode).toBe(403);
      expect((await pendingFor(eventId))[0].id).toBe(assignment.id);

      const declined = await request(app)
        .post(`/api/resolution-proposals/assignments/${assignment.id}/decline`)
        .set('Authorization', `Bearer ${await login(owner.email)}`);
      expect(declined.statusCode).toBe(200);

      const rows = await assignmentsFor(eventId);
      expect(rows.find((r) => r.id === assignment.id).status).toBe('declined');
      // The decline immediately re-draws — and cannot hand it back to the
      // user who just declined it.
      const pending = rows.filter((r) => r.status === 'pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].user_id).toBe(stranger.id);

      const again = await request(app)
        .post(`/api/resolution-proposals/assignments/${assignment.id}/decline`)
        .set('Authorization', `Bearer ${await login(owner.email)}`);
      expect(again.statusCode).toBe(409);
    });

    test('declining an unknown assignment is a 404', async () => {
      const user = await createUser();
      const res = await request(app)
        .post('/api/resolution-proposals/assignments/999999999/decline')
        .set('Authorization', `Bearer ${await login(user.email)}`);
      expect(res.statusCode).toBe(404);
    });

    test('config exposes the assignment window', async () => {
      const user = await createUser();
      const res = await request(app)
        .get('/api/resolution-proposals/config')
        .set('Authorization', `Bearer ${await login(user.email)}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.assignmentWindowHours).toBe(assignmentService.ASSIGNMENT_WINDOW_HOURS);
      expect(res.body.maxActiveAssignmentsPerUser).toBe(assignmentService.MAX_ACTIVE_ASSIGNMENTS_PER_USER);
      expect(res.body.proposerStakeRp).toBe(50);
    });
  });

  describe('proposal submission settles the assignment', () => {
    const propose = async (token, eventId) =>
      request(app)
        .post(`/api/events/${eventId}/resolution-proposals`)
        .set('Authorization', `Bearer ${token}`)
        .send({ outcome: 'yes', source_url: 'https://example.com/proof' });

    test('the assignee proposing completes their assignment and stakes 50 RP', async () => {
      const { eventId, users } = await buildScene({ candidates: 1 });
      await sweep([eventId]);
      const assignment = (await pendingFor(eventId))[0];
      const before = await db.query('SELECT rp_balance_ledger FROM users WHERE id = $1', [assignment.user_id]);

      const res = await propose(await login(users[0].email), eventId);
      expect(res.statusCode).toBe(201);
      expect(res.body.assignment_completed).toBe(true);

      const after = await db.query('SELECT rp_balance_ledger FROM users WHERE id = $1', [assignment.user_id]);
      // Assignment itself is free; the proposal still costs the 50 RP stake.
      expect(BigInt(before.rows[0].rp_balance_ledger) - BigInt(after.rows[0].rp_balance_ledger))
        .toBe(50n * LEDGER_SCALE);

      const rows = await assignmentsFor(eventId);
      expect(rows[0].status).toBe('completed');
      expect(rows[0].proposal_id).toBe(res.body.proposal.id);
      expect(rows[0].resolved_at).not.toBeNull();
    });

    test('a volunteer proposing cancels the assignment without penalising the assignee', async () => {
      const { eventId, users } = await buildScene({ candidates: 2 });
      await sweep([eventId]);
      const assignment = (await pendingFor(eventId))[0];
      const volunteer = users.find((u) => u.id !== assignment.user_id);

      const res = await propose(await login(volunteer.email), eventId);
      expect(res.statusCode).toBe(201);
      expect(res.body.assignment_completed).toBe(false);

      const rows = await assignmentsFor(eventId);
      expect(rows[0].status).toBe('cancelled');
      expect(rows[0].proposal_id).toBeNull();

      // 'cancelled' carries no re-draw exclusion: the assignee is still a
      // candidate for this market if the proposal later falls away.
      const reassignable = await db.query(
        `SELECT 1 FROM market_resolution_assignments
         WHERE event_id = $1 AND user_id = $2 AND status IN ('declined', 'expired')`,
        [eventId, assignment.user_id]
      );
      expect(reassignable.rows).toHaveLength(0);
    });
  });

  test('the daily resolution sweep runs the assignment pass', async () => {
    const { eventId } = await buildScene({ candidates: 1 });
    const controller = require('../src/controllers/marketResolutionController');
    const stats = await controller.sweepDueProposals();
    expect(stats.assignments).toBeDefined();
    expect(stats.assignments.error).toBeUndefined();
    expect(await pendingFor(eventId)).toHaveLength(1);
  });
});
