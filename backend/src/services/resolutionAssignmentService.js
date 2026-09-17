// Random resolution-proposer assignments.
//
// Markets that close without anyone volunteering a resolution used to sit
// there. This service hands each such market to one randomly drawn eligible
// user and asks them to propose an outcome. The assignment is free and
// non-exclusive: the assignee may decline or ignore it, and any other
// eligible user may still volunteer a proposal at the usual 50 RP stake —
// whoever proposes first settles the assignment.
//
// Locking discipline: whenever this service touches an assignment row it
// first takes `FOR UPDATE` on that assignment's event row, the same order
// marketResolutionController uses (event lock, then assignment write), so the
// two can never deadlock against each other. Sweeps are additionally
// serialized by a transaction-scoped advisory lock, so a cron run and a
// queue-triggered maintenance pass cannot draw for the same market twice.
const db = require('../db');
const {
  PROPOSER_STAKE_RP,
  PROPOSER_COOLDOWN_DAYS,
  ACTIVITY_DAYS,
  toLedgerString,
  involvementSql,
  proposerCooldownSql
} = require('../utils/marketResolutionEligibility');

const ASSIGNMENT_WINDOW_HOURS = 72;
const MAX_ACTIVE_ASSIGNMENTS_PER_USER = 3;
// A user who declined or let an assignment expire is not re-drawn for the
// same market this soon; other markets are unaffected.
const REASSIGN_EXCLUSION_DAYS = 7;

// How many markets one pass will look at. The daily sweep can afford a large
// batch; the maintenance pass piggybacked on an authenticated queue read must
// stay bounded so a page load never turns into a long transaction.
const SWEEP_EVENT_LIMIT = 200;
const QUEUE_EVENT_LIMIT = 5;
// Queue reads happen on every page focus; one pass per window is plenty.
const QUEUE_PASS_MIN_INTERVAL_MS = 30_000;

// Arbitrary but fixed: serializes assignment sweeps cluster-wide.
const SWEEP_ADVISORY_LOCK_KEY = 728411001;

const activeProposalSql = (eventParam) => `EXISTS (
  SELECT 1 FROM market_resolution_proposals ap
  WHERE ap.event_id = ${eventParam}
    AND ap.status IN ('voting', 'challenge_window', 'escalated')
)`;

// Everything that makes a user a valid assignee for THIS market, except the
// draw-only filters (activity window, per-user cap, prior decline/expiry).
// Reused as the revocation check, so an assignment is withdrawn as soon as
// its holder could no longer submit the proposal it asks for.
const assigneeStillEligibleSql = (eventParam, userParam, stakeParam, cooldownParam) => `(
  EXISTS (
    SELECT 1 FROM users eu
    WHERE eu.id = ${userParam}
      AND eu.deleted_at IS NULL
      AND eu.rp_balance_ledger >= ${stakeParam}::bigint
  )
  AND NOT ${involvementSql(eventParam, userParam)}
  AND NOT ${proposerCooldownSql(userParam, cooldownParam)}
)`;

const lockEvent = async (client, eventId) => {
  const res = await client.query(
    `SELECT id, outcome, hidden_at, closing_date, event_type
     FROM events WHERE id = $1 FOR UPDATE`,
    [eventId]
  );
  return res.rows[0] || null;
};

// Withdraw or retire the pending assignment of one already-locked event.
// Returns the per-status counts of what changed.
const maintainEventAssignments = async (client, eventId) => {
  const res = await client.query(
    `UPDATE market_resolution_assignments a
     SET status = CASE WHEN a.expires_at <= NOW() THEN 'expired' ELSE 'cancelled' END,
         resolved_at = NOW(),
         updated_at = NOW()
     FROM events e
     WHERE a.event_id = $1
       AND e.id = a.event_id
       AND a.status = 'pending'
       AND (
         a.expires_at <= NOW()
         OR e.outcome IS NOT NULL
         OR e.hidden_at IS NOT NULL
         OR ${activeProposalSql('a.event_id')}
         OR NOT ${assigneeStillEligibleSql('a.event_id', 'a.user_id', '$2', '$3')}
       )
     RETURNING a.id, a.status`,
    [eventId, toLedgerString(PROPOSER_STAKE_RP), String(PROPOSER_COOLDOWN_DAYS)]
  );
  return {
    expired: res.rows.filter((r) => r.status === 'expired').length,
    cancelled: res.rows.filter((r) => r.status === 'cancelled').length
  };
};

// Draw one assignee for an already-locked, already-verified market.
// Returns the assignment row, or null when nobody is eligible — in which case
// the market simply stays unassigned and the next sweep tries again.
const assignEvent = async (client, eventId) => {
  const candidate = await client.query(
    `SELECT u.id FROM users u
     WHERE u.deleted_at IS NULL
       AND u.last_active_at > NOW() - ($2 || ' days')::interval
       AND u.rp_balance_ledger >= $3::bigint
       AND NOT ${involvementSql('$1', 'u.id')}
       AND NOT ${proposerCooldownSql('u.id', '$4')}
       AND NOT EXISTS (
         SELECT 1 FROM market_resolution_assignments prior
         WHERE prior.event_id = $1
           AND prior.user_id = u.id
           AND prior.status IN ('declined', 'expired')
           AND prior.resolved_at > NOW() - ($5 || ' days')::interval
       )
       AND (
         SELECT COUNT(*) FROM market_resolution_assignments active
         WHERE active.user_id = u.id AND active.status = 'pending'
       ) < $6
     ORDER BY random()
     LIMIT 1`,
    [
      eventId,
      String(ACTIVITY_DAYS),
      toLedgerString(PROPOSER_STAKE_RP),
      String(PROPOSER_COOLDOWN_DAYS),
      String(REASSIGN_EXCLUSION_DAYS),
      MAX_ACTIVE_ASSIGNMENTS_PER_USER
    ]
  );
  if (candidate.rows.length === 0) return null;

  const inserted = await client.query(
    `INSERT INTO market_resolution_assignments (event_id, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [eventId, candidate.rows[0].id, String(ASSIGNMENT_WINDOW_HOURS)]
  );
  return inserted.rows[0] || null;
};

// Markets that want an assignee: closed, unresolved, visible, binary, with no
// active proposal and no live assignment. Sampled at random rather than
// oldest-first: a bounded pass that always looked at the same head of the
// list would spin forever on markets where everyone active is involved and
// never reach the rest.
const findAssignableEventIds = async (client, { eventIds, limit }) => {
  const scoped = Array.isArray(eventIds) && eventIds.length > 0;
  const params = scoped ? [eventIds] : [limit];
  const res = await client.query(
    `SELECT e.id FROM events e
     WHERE e.outcome IS NULL
       AND e.hidden_at IS NULL
       AND e.closing_date <= NOW()
       AND COALESCE(e.event_type, 'binary') = 'binary'
       AND NOT EXISTS (
         SELECT 1 FROM event_outcomes eo WHERE eo.event_id = e.id AND eo.is_active = TRUE
       )
       AND NOT ${activeProposalSql('e.id')}
       AND NOT EXISTS (
         SELECT 1 FROM market_resolution_assignments a
         WHERE a.event_id = e.id AND a.status = 'pending'
       )
       ${scoped ? 'AND e.id = ANY($1::int[])' : ''}
     ORDER BY random()
     ${scoped ? '' : 'LIMIT $1'}`,
    params
  );
  return res.rows.map((r) => r.id);
};

// Events whose pending assignment may need retiring (deadline passed, market
// resolved/hidden, someone proposed, assignee no longer eligible). Cheap
// pre-filter — the authoritative re-check happens under the event lock.
const findEventIdsNeedingMaintenance = async (client, { eventIds, limit }) => {
  const scoped = Array.isArray(eventIds) && eventIds.length > 0;
  const params = scoped
    ? [toLedgerString(PROPOSER_STAKE_RP), String(PROPOSER_COOLDOWN_DAYS), eventIds]
    : [toLedgerString(PROPOSER_STAKE_RP), String(PROPOSER_COOLDOWN_DAYS), limit];
  const res = await client.query(
    `SELECT DISTINCT a.event_id FROM market_resolution_assignments a
     JOIN events e ON e.id = a.event_id
     WHERE a.status = 'pending'
       AND (
         a.expires_at <= NOW()
         OR e.outcome IS NOT NULL
         OR e.hidden_at IS NOT NULL
         OR ${activeProposalSql('a.event_id')}
         OR NOT ${assigneeStillEligibleSql('a.event_id', 'a.user_id', '$1', '$2')}
       )
       ${scoped ? 'AND a.event_id = ANY($3::int[])' : ''}
     ORDER BY a.event_id
     ${scoped ? '' : 'LIMIT $3'}`,
    params
  );
  return res.rows.map((r) => r.event_id);
};

/**
 * One maintenance + assignment pass.
 *
 * Runs in a single transaction guarded by a try-only advisory lock: if
 * another sweep holds it, this pass reports `{ skipped: true }` rather than
 * queueing behind it, which keeps queue reads fast and cron runs idempotent.
 *
 * @param {object}   [opts]
 * @param {number[]} [opts.eventIds] Restrict the pass to these markets.
 * @param {number}   [opts.eventLimit] Max markets considered per stage.
 * @param {boolean}  [opts.assign] Set false to only retire stale assignments.
 */
const runAssignmentSweep = async ({
  eventIds = null,
  eventLimit = SWEEP_EVENT_LIMIT,
  assign = true
} = {}) => {
  const stats = { skipped: false, expired: 0, cancelled: 0, assigned: 0, unassigned: 0 };
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [SWEEP_ADVISORY_LOCK_KEY]
    );
    if (lock.rows[0].acquired !== true) {
      await client.query('ROLLBACK');
      return { ...stats, skipped: true };
    }

    const staleEventIds = await findEventIdsNeedingMaintenance(client, { eventIds, limit: eventLimit });
    for (const eventId of staleEventIds) {
      await lockEvent(client, eventId);
      const changed = await maintainEventAssignments(client, eventId);
      stats.expired += changed.expired;
      stats.cancelled += changed.cancelled;
    }

    if (assign) {
      const assignableEventIds = await findAssignableEventIds(client, { eventIds, limit: eventLimit });
      for (const eventId of assignableEventIds) {
        const event = await lockEvent(client, eventId);
        // Re-check under the lock: the market may have been resolved, hidden
        // or proposed on between the scan and now.
        if (!event || event.outcome || event.hidden_at) continue;
        if (new Date(event.closing_date) > new Date()) continue;
        const blocked = await client.query(
          `SELECT ${activeProposalSql('$1')} AS has_proposal,
                  EXISTS (
                    SELECT 1 FROM market_resolution_assignments a
                    WHERE a.event_id = $1 AND a.status = 'pending'
                  ) AS has_assignment`,
          [eventId]
        );
        if (blocked.rows[0].has_proposal || blocked.rows[0].has_assignment) continue;

        const assignment = await assignEvent(client, eventId);
        if (assignment) stats.assigned += 1;
        else stats.unassigned += 1;
      }
    }

    await client.query('COMMIT');
    return stats;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Assignment sweep rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
};

let lastQueuePassAt = 0;

// Best-effort bounded pass for authenticated queue reads: a stale or missing
// assignment should not survive just because the cron has not run yet, but a
// page load must never fail because maintenance did. Unscoped passes are also
// throttled per process, so a client refetching on every window focus cannot
// turn into a stream of sweeps.
const runQueueMaintenance = async (opts = {}) => {
  const scoped = Array.isArray(opts.eventIds) && opts.eventIds.length > 0;
  if (!scoped) {
    if (Date.now() - lastQueuePassAt < QUEUE_PASS_MIN_INTERVAL_MS) return null;
    lastQueuePassAt = Date.now();
  }
  try {
    return await runAssignmentSweep({ eventLimit: QUEUE_EVENT_LIMIT, ...opts });
  } catch (err) {
    console.error('Resolution assignment maintenance failed:', err.message);
    return null;
  }
};

// Tests drive several queue passes in a row; production never needs this.
const resetQueueMaintenanceThrottle = () => { lastQueuePassAt = 0; };

const listAssignmentsForUser = async (userId) => {
  const result = await db.query(
    `SELECT a.id, a.event_id, e.title AS event_title, a.expires_at
     FROM market_resolution_assignments a
     JOIN events e ON e.id = a.event_id
     WHERE a.user_id = $1 AND a.status = 'pending'
       AND a.expires_at > NOW()
       AND e.outcome IS NULL AND e.hidden_at IS NULL
       AND e.closing_date <= NOW()
       AND COALESCE(e.event_type, 'binary') = 'binary'
       AND NOT ${activeProposalSql('a.event_id')}
       AND ${assigneeStillEligibleSql('a.event_id', 'a.user_id', '$2', '$3')}
     ORDER BY a.expires_at ASC, a.id ASC`,
    [userId, toLedgerString(PROPOSER_STAKE_RP), String(PROPOSER_COOLDOWN_DAYS)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    event_id: row.event_id,
    event_title: row.event_title,
    expires_at: row.expires_at
  }));
};

/**
 * Hand an assignment back. Owner-only; the row is excluded from re-draws for
 * this market for REASSIGN_EXCLUSION_DAYS, and the market becomes assignable
 * again immediately.
 *
 * @returns {{status:number, body:object, eventId?:number}}
 */
const declineAssignment = async ({ userId, assignmentId }) => {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT id, event_id, user_id, status FROM market_resolution_assignments WHERE id = $1',
      [assignmentId]
    );
    if (owned.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 404, body: { message: 'Assignment not found' } };
    }
    if (owned.rows[0].user_id !== userId) {
      await client.query('ROLLBACK');
      return { status: 403, body: { message: 'This assignment belongs to another user' } };
    }

    // Event lock before the assignment lock, always.
    await lockEvent(client, owned.rows[0].event_id);
    const updated = await client.query(
      `UPDATE market_resolution_assignments
       SET status = 'declined', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
         AND expires_at > NOW()
       RETURNING id, event_id`,
      [assignmentId, userId]
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return { status: 409, body: { message: 'Assignment has expired or is no longer pending' } };
    }
    await client.query('COMMIT');
    return {
      status: 200,
      body: { assignment: { id: updated.rows[0].id, event_id: updated.rows[0].event_id, status: 'declined' } },
      eventId: updated.rows[0].event_id
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Decline rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Settle the pending assignment of a market the moment a proposal lands on
 * it. Must be called inside the proposal transaction, after the event row has
 * been locked: the assignee's own proposal completes their assignment, a
 * volunteer's proposal cancels it (no decline penalty for being beaten to it).
 *
 * @param {object} client Transaction client that already holds the event lock.
 */
const settleAssignmentsForProposal = async (client, { eventId, proposerUserId, proposalId }) => {
  const result = await client.query(
    `UPDATE market_resolution_assignments
     SET status = CASE WHEN user_id = $2 THEN 'completed' ELSE 'cancelled' END,
         proposal_id = CASE WHEN user_id = $2 THEN $3 ELSE proposal_id END,
         resolved_at = NOW(),
         updated_at = NOW()
     WHERE event_id = $1 AND status = 'pending'
     RETURNING id, status`,
    [eventId, proposerUserId, proposalId]
  );
  return {
    completed: result.rows.filter((r) => r.status === 'completed').length,
    cancelled: result.rows.filter((r) => r.status === 'cancelled').length
  };
};

module.exports = {
  ASSIGNMENT_WINDOW_HOURS,
  MAX_ACTIVE_ASSIGNMENTS_PER_USER,
  REASSIGN_EXCLUSION_DAYS,
  SWEEP_EVENT_LIMIT,
  QUEUE_EVENT_LIMIT,
  QUEUE_PASS_MIN_INTERVAL_MS,
  SWEEP_ADVISORY_LOCK_KEY,
  runAssignmentSweep,
  runQueueMaintenance,
  resetQueueMaintenanceThrottle,
  listAssignmentsForUser,
  declineAssignment,
  settleAssignmentsForProposal
};
