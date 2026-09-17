const db = require('../src/db');
const service = require('../src/services/resolutionAssignmentService');

describe('Resolution assignment concurrency and stale queues', () => {
  let userId;
  let eventId;

  beforeEach(async () => {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    userId = (await db.query(
      `INSERT INTO users (email, username, password_hash, rp_balance_ledger, last_active_at)
       VALUES ($1, $2, 'unused', 100000000, NOW()) RETURNING id`,
      [`edge_${tag}@example.com`, `edge_${tag}`]
    )).rows[0].id;
    eventId = (await db.query(
      `INSERT INTO events (title, closing_date, event_type)
       VALUES ('Assignment edge case', NOW() - INTERVAL '1 day', 'binary') RETURNING id`
    )).rows[0].id;
    await db.query(
      `INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares)
       SELECT id, $1, 0, 0 FROM users WHERE id <> $2
       ON CONFLICT (user_id, event_id) DO NOTHING`, [eventId, userId]
    );
  });

  afterEach(async () => {
    await db.query('DELETE FROM events WHERE id = $1', [eventId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('simultaneous sweeps create exactly one assignment without debiting the user', async () => {
    await Promise.all(Array.from({ length: 5 }, () => service.runAssignmentSweep({ eventIds: [eventId] })));
    const rows = await service.listAssignmentsForUser(userId);
    expect(rows.filter((row) => row.event_id === eventId)).toHaveLength(1);
    expect((await db.query('SELECT rp_balance_ledger FROM users WHERE id = $1', [userId])).rows[0].rp_balance_ledger).toBe('100000000');
  });

  test.each(['expired', 'hidden', 'resolved', 'involved', 'insufficient_balance'])(
    'queue filters %s assignments even without maintenance', async (reason) => {
      await service.runAssignmentSweep({ eventIds: [eventId] });
      if (reason === 'expired') await db.query("UPDATE market_resolution_assignments SET expires_at = NOW() - INTERVAL '1 minute' WHERE event_id = $1", [eventId]);
      if (reason === 'hidden') await db.query('UPDATE events SET hidden_at = NOW() WHERE id = $1', [eventId]);
      if (reason === 'resolved') await db.query("UPDATE events SET outcome = 'no' WHERE id = $1", [eventId]);
      if (reason === 'involved') await db.query('INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares) VALUES ($1, $2, 1, 0)', [userId, eventId]);
      if (reason === 'insufficient_balance') await db.query('UPDATE users SET rp_balance_ledger = 0 WHERE id = $1', [userId]);
      expect(await service.listAssignmentsForUser(userId)).toEqual([]);
    }
  );

  test('an expired assignment cannot be declined', async () => {
    await service.runAssignmentSweep({ eventIds: [eventId] });
    const [assignment] = await service.listAssignmentsForUser(userId);
    await db.query("UPDATE market_resolution_assignments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [assignment.id]);
    expect((await service.declineAssignment({ userId, assignmentId: assignment.id })).status).toBe(409);
  });
});
