# Random resolution-proposer assignments

Markets used to close and wait. Anyone *could* propose a resolution, but
nobody was ever *asked*, so binary markets piled up unresolved. This feature
hands every such market to one randomly drawn, eligible user and asks them to
propose the outcome — the same way jury duty is drawn, and with the same
exclusions.

Backend pieces:

| Piece | File |
|---|---|
| Schema | `backend/migrations/20260916_add_resolution_assignments.sql` |
| Draw / sweep / decline logic | `backend/src/services/resolutionAssignmentService.js` |
| Shared eligibility predicates | `backend/src/utils/marketResolutionEligibility.js` |
| Endpoints + sweep integration | `backend/src/controllers/marketResolutionController.js` |
| Routes | `backend/src/routes/api.js` |
| Tests | `backend/test/resolution_assignments.test.js`, `backend/test/resolution_assignment_service.test.js` |

## What gets assigned

A market is assignable when it is:

- past its `closing_date`,
- unresolved (`events.outcome IS NULL`),
- visible (`events.hidden_at IS NULL`),
- binary (`event_type` is `binary`/NULL and it has no active `event_outcomes`
  rows — multi-outcome and numeric markets are out),
- free of an active resolution proposal (`voting`, `challenge_window`,
  `escalated`),
- without a live (`pending`) assignment already.

Candidate markets are **sampled at random**, not taken oldest-first: a bounded
pass that always started at the head of the list would spin forever on markets
where every active user is involved, and never reach the rest.

## Who gets assigned

The draw picks uniformly at random (`ORDER BY random() LIMIT 1`) among users who:

- are not deleted,
- were active in the last **7 days** (`users.last_active_at`, the same window
  as the jury draw),
- are **not involved** in that market — shares, outcome shares, market
  updates, outcome updates, distribution trades or predictions. This is the
  identical predicate the jury draw and the proposal guard use, shared from
  `utils/marketResolutionEligibility.js` so the three can never drift apart,
- hold at least the **50 RP** proposer stake (being assigned a market you
  cannot afford to propose on is a dead end),
- are not serving the 7-day post-overturn proposer cooldown,
- have fewer than **3** live assignments,
- have not declined or let an assignment expire **for this same market** in
  the last **7 days**.

If nobody qualifies, the market is simply left unassigned — no row is
written, and the next sweep tries again. That is the normal state of affairs
on a market where everyone active has traded.

## Assignment lifecycle

`market_resolution_assignments.status`:

| Status | Meaning | Re-draw exclusion |
|---|---|---|
| `pending` | Live. Counts against the 3-per-user cap. Expires after **72h** (`assignmentWindowHours`). | — |
| `completed` | The assignee submitted a proposal for the market. | — |
| `declined` | The assignee handed it back via the decline endpoint. | 7 days, this market only |
| `expired` | The 72h deadline passed unanswered. | 7 days, this market only |
| `cancelled` | Withdrawn by maintenance: market resolved or hidden, someone else proposed, or the assignee stopped being eligible. | none — not the user's fault |

Declines and expiries free the market immediately: the same sweep pass that
expires an assignment re-draws the market, and a decline triggers a
maintenance pass scoped to that market before it returns.

**Assignment is free.** No RP is staked to receive one and none is lost by
declining or ignoring it. Submitting the proposal still costs the usual 50 RP
proposer stake, refunded with a 10 RP reward when the proposal is confirmed
and forfeited when it is overturned — unchanged from the volunteer path.

**Volunteers are preserved.** An assignment is an invitation, not a lock: any
eligible user may still propose on an assigned market. Whichever valid
proposal lands first settles the assignment in the *same transaction* that
creates the proposal — `completed` when the assignee proposed it, `cancelled`
when a volunteer beat them to it (no exclusion penalty for being beaten).

## Maintenance

Every pass, before drawing anything, retires `pending` assignments whose:

- deadline has passed → `expired`,
- market was resolved or hidden → `cancelled`,
- market picked up an active proposal → `cancelled`,
- holder is no longer eligible (deleted, now involved in the market, now
  under proposer cooldown, balance fell below the 50 RP stake) → `cancelled`.

The eligibility re-check runs on both sweeps and queue reads, so a stale
assignment never survives just because the cron has not fired yet.

## When passes run

1. **Daily cron.** `scripts/daily_cron.js` → `POST /api/resolution-proposals/sweep`
   → `sweepDueProposals()`, which settles elapsed challenge windows, escalates
   voting timeouts and *then* runs the assignment pass (up to 200 markets per
   stage). Its stats are reported under `stats.assignments`; a failure there is
   counted in `stats.errors` and never aborts the proposal sweep.
2. **Authenticated queue reads.** `GET /resolution-proposals/assignment-queue`
   runs a bounded pass first (5 markets per stage) so a user opening the page
   sees fresh, live assignments without the request turning into a long
   transaction. It is best-effort (if maintenance throws, the read still
   returns) and throttled to one pass per 30s per process, so a client
   refetching on every window focus cannot turn into a stream of sweeps.
3. **After a decline**, scoped to the market just freed.

## Concurrency

Two rules keep this safe against the proposal flow and against itself:

- **Event row lock before assignment row lock, always.** Every code path that
  writes an assignment first takes `SELECT … FROM events WHERE id = $1 FOR
  UPDATE` on that assignment's market — the same order
  `createProposal` uses — so a sweep and a proposal can never deadlock.
- **`pg_try_advisory_xact_lock`** serializes sweeps. A pass that cannot get
  the lock returns `{ skipped: true }` instead of queueing behind the running
  one, so a cron run and a dozen simultaneous queue reads cost one pass, not
  thirteen.

A partial unique index (`uq_market_resolution_assignments_active`, on
`event_id WHERE status = 'pending'`) makes "one live assignment per market" a
database invariant rather than a convention.

## API

### `GET /api/resolution-proposals/assignment-queue`

Authenticated. Returns the caller's live assignments, soonest deadline first:

```json
[{ "id": 12, "event_id": 341, "event_title": "Will X happen by June?", "expires_at": "2026-09-19T20:11:04.201Z" }]
```

### `POST /api/resolution-proposals/assignments/:id/decline`

Authenticated, owner-only.

| Code | Case |
|---|---|
| 200 | Declined; `{ assignment: { id, event_id, status: "declined" } }` |
| 400 | Malformed id |
| 403 | The assignment belongs to another user |
| 404 | No such assignment |
| 409 | The assignment expired or is no longer `pending` |

### `GET /api/resolution-proposals/config`

Gains `assignmentWindowHours` (72), `maxActiveAssignmentsPerUser` (3) and
`assignmentReassignExclusionDays` (7) alongside the existing proposal
economics.

### `POST /api/events/:eventId/resolution-proposals`

Unchanged, except the 201 body now also carries `assignment_completed`
(boolean): whether this proposal completed the proposer's own assignment.

## Tuning

All knobs are constants at the top of
`backend/src/services/resolutionAssignmentService.js`:
`ASSIGNMENT_WINDOW_HOURS`, `MAX_ACTIVE_ASSIGNMENTS_PER_USER`,
`REASSIGN_EXCLUSION_DAYS`, `SWEEP_EVENT_LIMIT`, `QUEUE_EVENT_LIMIT`. The
shared eligibility economics (`PROPOSER_STAKE_RP`, `PROPOSER_COOLDOWN_DAYS`,
`ACTIVITY_DAYS`) live in `backend/src/utils/marketResolutionEligibility.js`
and are used by the jury/proposal path too — changing them moves both.

## Testing

`backend/test/resolution_assignments.test.js` is an integration suite (real
Postgres, like `market_resolution_flow.test.js`). Because the draw is global
by construction, every scene isolates its candidate pool the way the jury
suite does — inserting zero-share `user_shares` rows makes every out-of-scene
user "involved" in that throwaway market, which the draw already excludes — and
every sweep it runs is scoped to the scene's own markets via
`runAssignmentSweep({ eventIds })`. No global user state is touched.

`backend/test/resolution_assignment_service.test.js` stubs the pool and covers
the control flow that SQL cannot show: advisory-lock back-off, rollback on
failure, error containment on queue reads, decline ownership branches, and the
event-lock-before-assignment-write ordering.

`backend/test/resolution_assignment_edge_cases.test.js` exercises concurrent
draws against PostgreSQL and verifies that queue reads exclude stale assignments
even when maintenance is skipped or throttled. Run these suites only against an
isolated test database: queue and daily-sweep tests intentionally exercise global
assignment draws.

## User interface and deployment

The Predictions page and terminal market panel show a "Markets assigned to you"
queue with deadlines, review links, and a free decline action. The existing
resolution form handles the outcome, evidence URL, and proposal stake. Successful
submission refreshes the queue. The terminal market detail now exposes that form
for closed binary markets as well.

`tests/e2e/resolution-assignment-ui.spec.js` tests both layouts against a static
build with mocked API responses; it does not require production accounts or data.

Deployment requires the new migration, backend restart, and frontend build and
publication together. The migration is additive. Existing daily resolution sweeps
will also draw assignments; authenticated queue reads run bounded, throttled
maintenance so assignments do not depend solely on the next daily cron run.

Deployed on 2026-09-16 with the migration, backend, and both frontend layouts.
The integrated release passed 51 resolution backend tests, 13 admin/bootstrap
regression tests, eight browser tests, and the frontend build. The first live
sweep created four assignments. A repeated sweep created none, user RP balances
were unchanged, and an authenticated assignee queue returned the live assignment.
The existing daily sweep and bounded queue-read maintenance are active.
