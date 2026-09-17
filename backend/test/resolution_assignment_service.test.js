// Behaviour of the assignment service that is about control flow rather than
// SQL semantics (lock contention, error containment, ownership checks), driven
// against a stubbed pool so it runs without a database.
jest.mock('../src/db', () => {
  const client = { query: jest.fn(), release: jest.fn() };
  return {
    __client: client,
    query: jest.fn(),
    getPool: () => ({ connect: jest.fn(async () => client) })
  };
});

const db = require('../src/db');
const service = require('../src/services/resolutionAssignmentService');

const client = db.__client;

const rows = (value) => ({ rows: value, rowCount: value.length });

beforeEach(() => {
  client.query.mockReset();
  client.release.mockReset();
  db.query.mockReset();
  service.resetQueueMaintenanceThrottle();
});

describe('runAssignmentSweep', () => {
  test('backs off instead of queueing when another sweep holds the advisory lock', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return rows([]);
      if (sql.includes('pg_try_advisory_xact_lock')) return rows([{ acquired: false }]);
      throw new Error(`unexpected query after failed lock: ${sql}`);
    });

    const stats = await service.runAssignmentSweep();

    expect(stats).toEqual({ skipped: true, expired: 0, cancelled: 0, assigned: 0, unassigned: 0 });
    const issued = client.query.mock.calls.map(([sql]) => sql);
    expect(issued).toContain('ROLLBACK');
    expect(issued).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('locks the event row before writing the assignment row', async () => {
    const issued = [];
    client.query.mockImplementation(async (sql) => {
      issued.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT') return rows([]);
      if (sql.includes('pg_try_advisory_xact_lock')) return rows([{ acquired: true }]);
      if (sql.includes('SELECT DISTINCT a.event_id')) return rows([]); // nothing stale
      if (sql.includes('SELECT e.id FROM events e')) return rows([{ id: 7 }]); // one assignable market
      if (sql.includes('FOR UPDATE')) {
        return rows([{ id: 7, outcome: null, hidden_at: null, closing_date: new Date(Date.now() - 86_400_000) }]);
      }
      if (sql.includes('has_proposal')) return rows([{ has_proposal: false, has_assignment: false }]);
      if (sql.includes('FROM users u')) return rows([{ id: 42 }]);
      if (sql.includes('INSERT INTO market_resolution_assignments')) {
        return rows([{ id: 1, event_id: 7, user_id: 42 }]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const stats = await service.runAssignmentSweep();

    expect(stats.assigned).toBe(1);
    const lockIndex = issued.findIndex((sql) => sql.includes('FROM events WHERE id = $1 FOR UPDATE'));
    const insertIndex = issued.findIndex((sql) => sql.includes('INSERT INTO market_resolution_assignments'));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(lockIndex);
    expect(issued).toContain('COMMIT');
  });

  test('counts a market with no eligible user as unassigned and still commits', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return rows([]);
      if (sql.includes('pg_try_advisory_xact_lock')) return rows([{ acquired: true }]);
      if (sql.includes('SELECT DISTINCT a.event_id')) return rows([]);
      if (sql.includes('SELECT e.id FROM events e')) return rows([{ id: 7 }]);
      if (sql.includes('FOR UPDATE')) {
        return rows([{ id: 7, outcome: null, hidden_at: null, closing_date: new Date(Date.now() - 86_400_000) }]);
      }
      if (sql.includes('has_proposal')) return rows([{ has_proposal: false, has_assignment: false }]);
      if (sql.includes('FROM users u')) return rows([]);
      throw new Error(`unexpected query: ${sql}`);
    });

    const stats = await service.runAssignmentSweep();

    expect(stats).toMatchObject({ assigned: 0, unassigned: 1, skipped: false });
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
  });

  test('rolls back and rethrows when a statement fails', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return rows([]);
      if (sql.includes('pg_try_advisory_xact_lock')) return rows([{ acquired: true }]);
      throw new Error('boom');
    });

    await expect(service.runAssignmentSweep()).rejects.toThrow('boom');
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('runQueueMaintenance', () => {
  test('never lets a failed maintenance pass break the queue read', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return rows([]);
      if (sql.includes('pg_try_advisory_xact_lock')) return rows([{ acquired: true }]);
      throw new Error('maintenance exploded');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(service.runQueueMaintenance()).resolves.toBeNull();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('throttles unscoped passes so repeated queue reads cost one sweep', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return rows([]);
      if (sql.includes('pg_try_advisory_xact_lock')) return rows([{ acquired: true }]);
      if (sql.includes('SELECT DISTINCT a.event_id')) return rows([]);
      if (sql.includes('SELECT e.id FROM events e')) return rows([]);
      throw new Error(`unexpected query: ${sql}`);
    });

    const first = await service.runQueueMaintenance();
    expect(first).not.toBeNull();
    const callsAfterFirst = client.query.mock.calls.length;

    expect(await service.runQueueMaintenance()).toBeNull();
    expect(client.query.mock.calls).toHaveLength(callsAfterFirst);

    // A decline naming its market is never throttled — the freed market has
    // to be re-drawn now, not in half a minute.
    expect(await service.runQueueMaintenance({ eventIds: [7] })).not.toBeNull();
    expect(client.query.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test('bounds the work it does on a queue read', async () => {
    let scanLimit = null;
    client.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return rows([]);
      if (sql.includes('pg_try_advisory_xact_lock')) return rows([{ acquired: true }]);
      if (sql.includes('SELECT DISTINCT a.event_id')) return rows([]);
      if (sql.includes('SELECT e.id FROM events e')) {
        scanLimit = params[0];
        return rows([]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await service.runQueueMaintenance();

    expect(scanLimit).toBe(service.QUEUE_EVENT_LIMIT);
    expect(service.QUEUE_EVENT_LIMIT).toBeLessThan(service.SWEEP_EVENT_LIMIT);
  });
});

describe('declineAssignment', () => {
  test('rejects a decline from someone who does not own the assignment', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return rows([]);
      if (sql.startsWith('SELECT id, event_id, user_id, status')) {
        return rows([{ id: 5, event_id: 7, user_id: 11, status: 'pending' }]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service.declineAssignment({ userId: 12, assignmentId: 5 });

    expect(result.status).toBe(403);
    const issued = client.query.mock.calls.map(([sql]) => sql);
    expect(issued).toContain('ROLLBACK');
    expect(issued.some((sql) => sql.includes('UPDATE market_resolution_assignments'))).toBe(false);
  });

  test('reports a missing assignment as 404', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return rows([]);
      if (sql.startsWith('SELECT id, event_id, user_id, status')) return rows([]);
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service.declineAssignment({ userId: 12, assignmentId: 5 });
    expect(result.status).toBe(404);
  });

  test('declines an owned pending assignment and reports the freed market', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return rows([]);
      if (sql.startsWith('SELECT id, event_id, user_id, status')) {
        return rows([{ id: 5, event_id: 7, user_id: 12, status: 'pending' }]);
      }
      if (sql.includes('FOR UPDATE')) return rows([{ id: 7 }]);
      if (sql.includes("SET status = 'declined'")) return rows([{ id: 5, event_id: 7 }]);
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service.declineAssignment({ userId: 12, assignmentId: 5 });

    expect(result.status).toBe(200);
    expect(result.eventId).toBe(7);
    expect(result.body.assignment).toEqual({ id: 5, event_id: 7, status: 'declined' });
    const issued = client.query.mock.calls.map(([sql]) => sql);
    expect(issued.findIndex((sql) => sql.includes('FOR UPDATE')))
      .toBeLessThan(issued.findIndex((sql) => sql.includes("SET status = 'declined'")));
  });

  test('reports an already-settled assignment as 409 without committing', async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return rows([]);
      if (sql.startsWith('SELECT id, event_id, user_id, status')) {
        return rows([{ id: 5, event_id: 7, user_id: 12, status: 'pending' }]);
      }
      if (sql.includes('FOR UPDATE')) return rows([{ id: 7 }]);
      if (sql.includes("SET status = 'declined'")) return rows([]);
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service.declineAssignment({ userId: 12, assignmentId: 5 });

    expect(result.status).toBe(409);
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  });
});

describe('settleAssignmentsForProposal', () => {
  test('completes the assignee\'s own proposal and cancels a volunteer\'s', async () => {
    const txClient = { query: jest.fn(async () => rows([{ id: 1, status: 'completed' }, { id: 2, status: 'cancelled' }])) };

    const result = await service.settleAssignmentsForProposal(txClient, {
      eventId: 7,
      proposerUserId: 42,
      proposalId: 99
    });

    expect(result).toEqual({ completed: 1, cancelled: 1 });
    const [sql, params] = txClient.query.mock.calls[0];
    // Runs on the caller's transaction (which already holds the event lock).
    expect(sql).toContain('UPDATE market_resolution_assignments');
    expect(sql).toContain("status = 'pending'");
    expect(params).toEqual([7, 42, 99]);
  });
});
