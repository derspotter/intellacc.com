# My Positions Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A persistent "My Positions" section at the top of the predictions Markets tab that always shows every market the user invested in — open positions (including junk-hidden markets) plus markets resolved within the last 7 days.

**Architecture:** One new timestamp column (`events.resolved_at`, stamped by the engine's two resolution transactions and the backend's `resolveEvent`), an enriched `GET /users/:id/positions` that returns card-ready event data in three UNION branches (binary open, multi-outcome open, recently resolved via trade history), and a section rendered inside `EventsList.jsx` from the existing `userPositions` signal. The section never touches `GET /events`, so the junk filter / 500-id cap / open-only default cannot hide a position.

**Tech Stack:** PostgreSQL migration (plain SQL, auto-run on backend start), Rust/SQLx (prediction-engine), Express + pg (backend), SolidJS (frontend), Jest + supertest (backend tests), Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-07-07-my-positions-section-design.md`

## Global Constraints

- Docker-based: run backend tests inside `intellacc_backend`, DB access via `docker exec intellacc_db psql -U intellacc_user -d intellaccdb`.
- Backend jest against shared DB: always `--runInBand`, always clean up seeded rows in `afterAll`.
- Migrations auto-run on backend container start and may replay on fresh DBs — every migration must be idempotent (`IF NOT EXISTS`, guarded UPDATE).
- Engine is built in Docker only — never `cargo` on the host. Test via `./scripts/test_prediction_engine.sh`.
- E2E: base URL `http://localhost:4174`, login `user1@example.com / password123`, seed via `docker exec intellacc_db psql -qtAc`.
- Frontend has no unit-test runner; verification is E2E + manual.
- Commit after every task (cluster style: one commit per task is fine).

---

### Task 1: `events.resolved_at` — migration + engine stamps

**Files:**
- Create: `backend/migrations/20260707_add_events_resolved_at.sql`
- Modify: `prediction-engine/src/lmsr_api.rs:1344` (binary resolution) and `:1428-1434` (outcome resolution)
- Modify: `prediction-engine/src/integration_tests.rs:203-217` (test schema), `:405-420` (post-resolution invariant)

**Interfaces:**
- Produces: `events.resolved_at TIMESTAMPTZ` — NULL for unresolved events, `NOW()` at resolution time, backfilled from `updated_at` for events resolved before this change. Tasks 2–4 rely on this column existing and being stamped.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/20260707_add_events_resolved_at.sql`:

```sql
-- Settlement deletes user share rows, so events.resolved_at is the only
-- durable record of WHEN a market resolved — needed for the "recently
-- resolved" window in the My Positions section.
ALTER TABLE events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Approximate backfill for events resolved before this column existed.
-- updated_at is a rough proxy (resolved markets stop trading), good enough
-- for a 7-day display window.
UPDATE events
SET resolved_at = updated_at
WHERE outcome IS NOT NULL AND resolved_at IS NULL;
```

- [ ] **Step 2: Apply the migration to the dev DB and verify**

```bash
docker exec -i intellacc_db psql -U intellacc_user -d intellaccdb < backend/migrations/20260707_add_events_resolved_at.sql
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c \
  "SELECT COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS backfilled, COUNT(*) AS resolved FROM events WHERE outcome IS NOT NULL"
```

Expected: both counts equal (every resolved event has a backfilled `resolved_at`). The file is idempotent, so the auto-runner replaying it on backend start is harmless.

- [ ] **Step 3: Write the failing engine test assertion**

In `prediction-engine/src/integration_tests.rs`, inside `verify_post_resolution_invariant` (line ~405), after the `remaining_shares` check, add:

```rust
    // resolved_at must be stamped in the same transaction that settles the market
    let resolved_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT resolved_at FROM events WHERE id = $1")
            .bind(event_id)
            .fetch_one(pool)
            .await?;
    if resolved_at.is_none() {
        return Err(anyhow!(
            "Post-resolution invariant violation: resolved_at not stamped for event {}",
            event_id
        ));
    }
```

(If `chrono` isn't in scope, use the sqlx re-export: `sqlx::types::chrono::{DateTime, Utc}`.)

Also add the column to the test schema's events table (line ~203, `CREATE TABLE IF NOT EXISTS events (...)`): after `event_type VARCHAR(32) NOT NULL DEFAULT 'binary'` add:

```sql
            , resolved_at TIMESTAMP WITH TIME ZONE
```

**Note:** the test harness uses `CREATE TABLE IF NOT EXISTS` — if the test DB persists between runs, the new column won't be added to an existing table. Check how the harness resets its DB; if tables persist, also add `ALTER TABLE events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;` right after the CREATE in the test setup.

- [ ] **Step 4: Run engine suite to verify the new assertion fails**

```bash
./scripts/test_prediction_engine.sh
```

Expected: FAIL with "resolved_at not stamped" (the resolution paths don't set it yet).

- [ ] **Step 5: Stamp resolved_at in both resolution transactions**

`prediction-engine/src/lmsr_api.rs` line 1344 (binary path):

```rust
    sqlx::query("UPDATE events SET outcome = $1, resolved_at = NOW() WHERE id = $2")
        .bind(outcome_str)
        .bind(event_id)
        .execute(tx.as_mut())
        .await?;
```

Line ~1428 (outcome path):

```rust
    sqlx::query(
        "UPDATE events
         SET outcome = $1,
             resolution_outcome_id = $2,
             numerical_outcome = COALESCE($3, numerical_outcome),
             resolved_at = NOW()
         WHERE id = $4",
    )
```

These two transactions are the only engine sites that set `events.outcome` (verified by grep; `resolution_sync.rs` funnels through `lmsr_api::resolve_event`).

- [ ] **Step 6: Run engine suite to verify it passes**

```bash
./scripts/test_prediction_engine.sh
```

Expected: PASS.

- [ ] **Step 7: Rebuild the engine container**

```bash
docker compose up -d --build prediction-engine
```

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/20260707_add_events_resolved_at.sql prediction-engine/src/lmsr_api.rs prediction-engine/src/integration_tests.rs
git commit -m "feat(engine): stamp events.resolved_at at settlement

Settlement deletes user share rows, so resolved_at is the only durable
record of when a market settled. Backfills existing resolved events from
updated_at.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Enriched positions endpoint + backend resolveEvent stamp

**Files:**
- Modify: `backend/src/controllers/userController.js:1260-1331` (`getUserPositions`)
- Modify: `backend/src/controllers/predictionsController.js:561-570` (`resolveEvent` UPDATE)
- Test: `backend/test/user_positions_portfolio.test.js` (new)

**Interfaces:**
- Consumes: `events.resolved_at` from Task 1.
- Produces: `GET /api/users/:id/positions` returns a flat array of rows, one per binary position / per multi-outcome holding / per recently-resolved invested market. Each row now additionally carries:
  - `position_kind`: `'open' | 'resolved'`
  - `liquidity_b`, `outcome`, `resolution_outcome_id`, `resolution_outcome_label`, `resolved_at`, `hidden_at`
  - Existing fields unchanged: `event_id`, `yes_shares`, `no_shares`, `outcome_id`, `outcome_label`, `outcome_shares`, `outcome_staked_rp`, `event_title`, `category`, `closing_date`, `market_prob`, `cumulative_stake`, `event_type`, `last_updated`.
  - `'resolved'` rows have NULL share fields and appear only for events with `outcome IS NOT NULL AND resolved_at > NOW() - 7 days` where the user has rows in `market_updates` or `market_outcome_updates`.
  - Backward compatible: existing consumers (`MarketEventCard`, `OutcomeMarketCard`) filter by `event_id` of an unresolved event, which never matches a `'resolved'` row.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/user_positions_portfolio.test.js`:

```js
// GET /api/users/:id/positions: card-ready portfolio rows. Open positions
// include junk-hidden markets (the browse listing's hidden_at filter must
// never hide a user's own holdings); markets resolved within 7 days appear
// as position_kind 'resolved' derived from trade history.
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const makeUser = async (label) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  await request(app).post('/api/users/register').send({ username: unique, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  expect(loginRes.statusCode).toBe(200);
  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: userResult.rows[0].id, token: loginRes.body.token };
};

describe('GET /api/users/:id/positions portfolio', () => {
  const cleanup = { eventIds: [], userIds: [] };
  let user;

  beforeAll(async () => {
    user = await makeUser('portfolio_user');
    cleanup.userIds.push(user.id);
  });

  afterAll(async () => {
    if (cleanup.eventIds.length) {
      await db.query('DELETE FROM market_updates WHERE event_id = ANY($1::int[])', [cleanup.eventIds]);
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
    if (cleanup.userIds.length) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  const insertEvent = async (title, { hidden = false, outcome = null, resolvedAgoDays = null, eventType = 'binary' } = {}) => {
    const result = await db.query(
      `INSERT INTO events (title, closing_date, event_type, outcome, resolved_at, hidden_at, hidden_reason)
       VALUES ($1, NOW() + INTERVAL '30 days', $2, $3,
               CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - ($4::int * INTERVAL '1 day') END,
               $5, $6)
       RETURNING id`,
      [title, eventType, outcome, resolvedAgoDays, hidden ? new Date() : null, hidden ? 'llm: test junk' : null]
    );
    cleanup.eventIds.push(result.rows[0].id);
    return result.rows[0].id;
  };

  const insertBinaryShares = (eventId, yes = 10) =>
    db.query('INSERT INTO user_shares (user_id, event_id, yes_shares) VALUES ($1, $2, $3)', [user.id, eventId, yes]);

  const insertTrade = (eventId) =>
    db.query(
      `INSERT INTO market_updates (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until)
       VALUES ($1, $2, 0.5, 0.55, 10, 18, 'yes', NOW())`,
      [user.id, eventId]
    );

  const fetchPositions = async () => {
    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  test('open binary position carries card-ready event fields', async () => {
    const eventId = await insertEvent(`portfolio open ${Date.now()}`);
    await insertBinaryShares(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('open');
    expect(Number(row.yes_shares)).toBe(10);
    expect(row.event_title).toContain('portfolio open');
    expect(row.liquidity_b).not.toBeNull();
    expect(row.hidden_at).toBeNull();
  });

  test('junk-hidden market with a position is still returned, flagged via hidden_at', async () => {
    const eventId = await insertEvent(`portfolio hidden ${Date.now()}`, { hidden: true });
    await insertBinaryShares(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('open');
    expect(row.hidden_at).not.toBeNull();
  });

  test('multi-outcome position rows carry outcome labels', async () => {
    const eventId = await insertEvent(`portfolio mc ${Date.now()}`, { eventType: 'multiple_choice' });
    const outcomeResult = await db.query(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES ($1, 'choice_1', 'Alpha', 0) RETURNING id`,
      [eventId]
    );
    await db.query(
      `INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
       VALUES ($1, $2, $3, 12.5, 10000000)`,
      [user.id, eventId, outcomeResult.rows[0].id]
    );
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('open');
    expect(row.outcome_label).toBe('Alpha');
    expect(Number(row.outcome_shares)).toBeCloseTo(12.5);
  });

  test('market resolved 2 days ago with a prior trade appears as resolved', async () => {
    const eventId = await insertEvent(`portfolio resolved ${Date.now()}`, { outcome: 'resolved_yes', resolvedAgoDays: 2 });
    await insertTrade(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeDefined();
    expect(row.position_kind).toBe('resolved');
    expect(row.outcome).toBe('resolved_yes');
    expect(row.yes_shares).toBeNull();
  });

  test('market resolved 10 days ago is excluded', async () => {
    const eventId = await insertEvent(`portfolio stale ${Date.now()}`, { outcome: 'resolved_no', resolvedAgoDays: 10 });
    await insertTrade(eventId);
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeUndefined();
  });

  test('recently resolved market the user never traded is excluded', async () => {
    const eventId = await insertEvent(`portfolio untraded ${Date.now()}`, { outcome: 'resolved_yes', resolvedAgoDays: 1 });
    const row = (await fetchPositions()).find((r) => r.event_id === eventId);
    expect(row).toBeUndefined();
  });

  test("cannot fetch another user's positions", async () => {
    const other = await makeUser('portfolio_other');
    cleanup.userIds.push(other.id);
    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify the new-behavior ones fail**

```bash
docker exec intellacc_backend npx jest test/user_positions_portfolio.test.js --runInBand
```

Expected: the open-position tests fail on missing `position_kind`/`liquidity_b`/`hidden_at` fields, and the resolved-market tests fail (no third branch yet). The 403 test should already pass.

- [ ] **Step 3: Rewrite the getUserPositions query**

In `backend/src/controllers/userController.js`, replace the body of `exports.getUserPositions` (keep the auth checks at lines 1263-1272, delete the two `console.log` debug lines at 1274 and 1323):

```js
    const result = await db.query(`
      SELECT
        us.event_id,
        'open'::text AS position_kind,
        us.yes_shares,
        us.no_shares,
        NULL::bigint AS outcome_id,
        NULL::text AS outcome_label,
        NULL::double precision AS outcome_shares,
        NULL::numeric AS outcome_staked_rp,
        e.title AS event_title,
        'General'::text AS category,
        e.closing_date,
        e.market_prob,
        e.cumulative_stake,
        e.liquidity_b,
        e.event_type,
        e.outcome,
        e.resolution_outcome_id,
        reo.label AS resolution_outcome_label,
        e.resolved_at,
        e.hidden_at,
        us.last_updated AS last_updated
      FROM user_shares us
      JOIN events e ON us.event_id = e.id
      LEFT JOIN event_outcomes reo ON reo.id = e.resolution_outcome_id
      WHERE us.user_id = $1
        AND (us.yes_shares > 0 OR us.no_shares > 0)

      UNION ALL

      SELECT
        uos.event_id,
        'open'::text AS position_kind,
        0::double precision AS yes_shares,
        0::double precision AS no_shares,
        uos.outcome_id,
        eo.label AS outcome_label,
        uos.shares AS outcome_shares,
        (uos.staked_ledger::numeric / 1000000.0) AS outcome_staked_rp,
        e.title AS event_title,
        'General'::text AS category,
        e.closing_date,
        e.market_prob,
        e.cumulative_stake,
        e.liquidity_b,
        e.event_type,
        e.outcome,
        e.resolution_outcome_id,
        reo.label AS resolution_outcome_label,
        e.resolved_at,
        e.hidden_at,
        uos.updated_at AS last_updated
      FROM user_outcome_shares uos
      JOIN events e ON uos.event_id = e.id
      JOIN event_outcomes eo ON eo.id = uos.outcome_id
      LEFT JOIN event_outcomes reo ON reo.id = e.resolution_outcome_id
      WHERE uos.user_id = $1
        AND uos.shares > 0

      UNION ALL

      -- Settlement deletes share rows, so recently resolved holdings are
      -- reconstructed from trade history.
      SELECT
        e.id AS event_id,
        'resolved'::text AS position_kind,
        NULL::double precision AS yes_shares,
        NULL::double precision AS no_shares,
        NULL::bigint AS outcome_id,
        NULL::text AS outcome_label,
        NULL::double precision AS outcome_shares,
        NULL::numeric AS outcome_staked_rp,
        e.title AS event_title,
        'General'::text AS category,
        e.closing_date,
        e.market_prob,
        e.cumulative_stake,
        e.liquidity_b,
        e.event_type,
        e.outcome,
        e.resolution_outcome_id,
        reo.label AS resolution_outcome_label,
        e.resolved_at,
        e.hidden_at,
        e.resolved_at AS last_updated
      FROM events e
      LEFT JOIN event_outcomes reo ON reo.id = e.resolution_outcome_id
      WHERE e.outcome IS NOT NULL
        AND e.resolved_at > NOW() - INTERVAL '7 days'
        AND (
          EXISTS (SELECT 1 FROM market_updates mu WHERE mu.user_id = $1 AND mu.event_id = e.id)
          OR EXISTS (SELECT 1 FROM market_outcome_updates mou WHERE mou.user_id = $1 AND mou.event_id = e.id)
        )

      ORDER BY last_updated DESC
    `, [authedUserId]);

    res.status(200).json(result.rows);
```

- [ ] **Step 4: Stamp resolved_at in backend resolveEvent**

`backend/src/controllers/predictionsController.js` line ~561 — the direct UPDATE after the engine call (belt-and-braces: the engine transaction already stamped it, but this UPDATE overwrites the row's outcome fields and must not leave resolved_at NULL if the engine schema drifts):

```js
  const update = await db.query(
    `UPDATE events
     SET outcome = $1,
         numerical_outcome = $2,
         resolution_outcome_id = $3,
         resolved_at = COALESCE(resolved_at, NOW()),
         updated_at = NOW()
     WHERE id = $4
     RETURNING id, title, outcome, numerical_outcome, resolution_outcome_id, closing_date`,
    [backendOutcome, backendNumericalOutcome, resolvedOutcomeId, eventId]
  );
```

- [ ] **Step 5: Restart backend and run the tests**

```bash
docker compose restart backend && sleep 5
docker exec intellacc_backend npx jest test/user_positions_portfolio.test.js --runInBand
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Run the neighboring suites to catch regressions**

```bash
docker exec intellacc_backend npx jest test/events_listing.test.js test/market_lifecycle.test.js test/event_resolution.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/controllers/userController.js backend/src/controllers/predictionsController.js backend/test/user_positions_portfolio.test.js
git commit -m "feat(api): card-ready portfolio rows from /users/:id/positions

Three-branch union: binary open, multi-outcome open, and markets resolved
within 7 days reconstructed from trade history. Deliberately no hidden_at
filter — a user's own holdings must never be junk-filtered away.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: My Positions section in EventsList

**Files:**
- Modify: `frontend-solid/src/components/predictions/EventsList.jsx`
- Modify: `frontend-solid/src/styles.css` (after `.event-position-tag`, ~line 4394; dark overrides near `body.dark-mode .event-prob-bar`, ~line 856)

**Interfaces:**
- Consumes: enriched positions rows from Task 2 (`position_kind`, `event_title`, `market_prob`, `liquidity_b`, `event_type`, `outcome`, `resolution_outcome_label`, `resolved_at`, `hidden_at`, `outcome_label`, `outcome_shares`, `yes_shares`, `no_shares`).
- Produces: CSS classes `my-positions-card`, `my-positions-header`, `my-positions-error`, `event-unlisted-tag`, `event-settled-tag`, `position-resolved` (Task 4's E2E selectors).

- [ ] **Step 1: Add section state and grouping logic**

In `EventsList.jsx`, next to the existing `userPositions` signal (line ~63):

```js
  const [positionsError, setPositionsError] = createSignal('');
  const [positionsSectionOpen, setPositionsSectionOpen] = createSignal(true);
  const [expandedPositionIds, setExpandedPositionIds] = createSignal(new Set());

  const togglePositionExpanded = (id) => {
    setExpandedPositionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
```

Update `loadUserPositions` (line ~200) to surface errors instead of swallowing them:

```js
    setPositionsLoading(true);
    setPositionsError('');
    try {
      const response = await getUserPositions(userId);
      setUserPositions(normalizeRows(response));
    } catch (err) {
      setUserPositions([]);
      setPositionsError(err?.message || 'Failed to load your positions.');
    } finally {
      setPositionsLoading(false);
    }
```

Add the grouping memo (one entry per market; binary shares and multi-outcome holdings unified into an `outcomes` list for the row meta):

```js
  // One entry per invested market. Open positions sorted most-urgent-first,
  // recently resolved ones after, newest resolution first.
  const positionGroups = createMemo(() => {
    const byId = new Map();
    for (const row of userPositions() || []) {
      const key = String(row.event_id);
      if (!byId.has(key)) {
        byId.set(key, {
          event: {
            id: row.event_id,
            title: row.event_title,
            closing_date: row.closing_date,
            market_prob: row.market_prob,
            cumulative_stake: row.cumulative_stake,
            liquidity_b: row.liquidity_b,
            event_type: row.event_type,
            outcome: row.outcome
          },
          kind: row.position_kind === 'resolved' ? 'resolved' : 'open',
          hidden: !!row.hidden_at,
          resolvedAt: row.resolved_at,
          resolutionLabel: row.resolution_outcome_label,
          outcomes: []
        });
      }
      const group = byId.get(key);
      if (row.outcome_label && Number(row.outcome_shares) > 0) {
        group.outcomes.push({ label: row.outcome_label, shares: Number(row.outcome_shares) });
      }
      if (Number(row.yes_shares) > 0) group.outcomes.push({ label: 'YES', shares: Number(row.yes_shares) });
      if (Number(row.no_shares) > 0) group.outcomes.push({ label: 'NO', shares: Number(row.no_shares) });
    }
    const groups = [...byId.values()];
    const open = groups
      .filter((g) => g.kind === 'open')
      .sort((a, b) => new Date(a.event.closing_date) - new Date(b.event.closing_date));
    const resolved = groups
      .filter((g) => g.kind === 'resolved')
      .sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    return { open, resolved, all: [...open, ...resolved] };
  });

  const settledOutcomeText = (group) => {
    if (group.resolutionLabel) return group.resolutionLabel;
    const raw = String(group.event.outcome || '').toLowerCase();
    if (raw.includes('yes')) return 'YES';
    if (raw.includes('no')) return 'NO';
    return 'Resolved';
  };
```

Restrict the main-list "Position" tag to open holdings — replace the `positionEventIds` memo (line ~365):

```js
  const positionEventIds = createMemo(
    () =>
      new Set(
        (userPositions() || [])
          .filter((p) => p.position_kind !== 'resolved')
          .map((p) => String(p.event_id))
      )
  );
```

- [ ] **Step 2: Render the section**

In the return JSX, insert directly after `<section class="events-container">` (before `<div class="events-list-card">`):

```jsx
      <Show when={authed() && (positionGroups().all.length > 0 || positionsError())}>
        <div class="events-list-card my-positions-card">
          <div
            class="my-positions-header"
            onClick={() => setPositionsSectionOpen(!positionsSectionOpen())}
          >
            <h2>{`My Positions (${positionGroups().open.length})`}</h2>
            <span class="my-positions-toggle" aria-hidden="true">
              {positionsSectionOpen() ? '▾' : '▸'}
            </span>
          </div>

          <Show when={positionsSectionOpen()}>
            <Show when={positionsError()}>
              <div class="my-positions-error">
                <p>{positionsError()}</p>
                <button type="button" class="secondary" onClick={() => void loadUserPositions()}>
                  Retry
                </button>
              </div>
            </Show>

            <ul class="events-simple-list">
              <For each={positionGroups().all}>
                {(group) => {
                  const isResolved = group.kind === 'resolved';
                  const rowKey = `pos-${group.event.id}`;
                  const prob = () => Number(group.event.market_prob ?? 0.5);
                  return (
                    <li
                      class={`event-list-item ${isResolved ? 'position-resolved' : ''} ${expandedPositionIds().has(rowKey) ? 'expanded' : ''}`}
                    >
                      <div
                        class="event-list-item-row"
                        onClick={() => {
                          if (!isResolved) togglePositionExpanded(rowKey);
                        }}
                      >
                        <div class="event-list-item-header">
                          <span class="event-title">{group.event.title}</span>
                          <span class="event-prob">{formatProbability(group.event.market_prob || 0.5)}</span>
                        </div>
                        <div class="event-prob-bar" aria-hidden="true">
                          <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
                        </div>
                        <div class="event-list-item-meta">
                          <Show when={group.outcomes.length > 0}>
                            <span class="event-category">
                              {group.outcomes.map((o) => `${o.label} ×${o.shares.toFixed(1)}`).join(' · ')}
                            </span>
                          </Show>
                          <Show when={!isResolved}>
                            <span class="event-date">{`Closes: ${formatDate(group.event.closing_date)}`}</span>
                          </Show>
                          <Show when={group.hidden}>
                            <span class="event-unlisted-tag">Unlisted</span>
                          </Show>
                          <Show when={isResolved}>
                            <span class="event-settled-tag">{`Settled: ${settledOutcomeText(group)}`}</span>
                          </Show>
                        </div>
                      </div>
                      <Show when={!isResolved && expandedPositionIds().has(rowKey)}>
                        <div class="event-row-expanded">
                          <Show
                            when={isMultiOutcome(group.event)}
                            fallback={
                              <MarketEventCard
                                event={group.event}
                                onTrade={handleTradeRefresh}
                                onVerificationNotice={props.onVerificationNotice}
                                hideTitle={true}
                                authenticated={authed()}
                              />
                            }
                          >
                            <OutcomeMarketCard
                              event={group.event}
                              onTrade={handleTradeRefresh}
                              onVerificationNotice={props.onVerificationNotice}
                              hideTitle={true}
                            />
                          </Show>
                        </div>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
```

(`handleTradeRefresh` already reloads both the market list and `userPositions`, so trades made inside the section update it in place.)

- [ ] **Step 3: Remove the superseded my-positions filter**

Still in `EventsList.jsx`:

1. Delete the dropdown option block (line ~442-444):

```jsx
              <Show when={authed()}>
                <option value="my-positions">My Positions</option>
              </Show>
```

2. In `loadEvents` (line ~98-111), delete the `if (filter() === 'my-positions') { ... } else { ... }` branch, keeping only:

```js
      params.filter = filter();
```

3. In `handleFilterChange` (line ~369-375), delete the special case, leaving:

```js
  const handleFilterChange = async (value) => {
    setFilter(value);
    void loadEvents({ reset: true });
  };
```

- [ ] **Step 4: Add the CSS**

In `frontend-solid/src/styles.css`, after `.event-position-tag` (~line 4394):

```css
/* My Positions section — same Bauhaus row language as the main list */
.my-positions-card {
  margin-bottom: 1rem;
}
.my-positions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #000;
}
.my-positions-header h2 {
  margin: 0;
}
.my-positions-error {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
}
.event-unlisted-tag {
  border: 1px dashed #000;
  padding: 0 0.35rem;
  border-radius: 2px;
  font-weight: 600;
  opacity: 0.8;
}
.event-settled-tag {
  background: #000;
  color: #fff;
  padding: 0 0.35rem;
  border-radius: 2px;
  font-weight: 600;
}
.event-list-item.position-resolved {
  opacity: 0.55;
}
```

And with the dark-mode overrides (near `body.dark-mode .event-prob-bar`, ~line 856):

```css
body.dark-mode .my-positions-header {
  border-bottom-color: var(--border-color);
}
body.dark-mode .event-unlisted-tag {
  border-color: var(--border-color);
}
body.dark-mode .event-settled-tag {
  background: var(--text-color);
  color: var(--card-bg);
}
```

- [ ] **Step 5: Deploy and smoke-check manually**

```bash
docker compose restart frontend-solid
```

Then verify at `http://localhost:4174/#predictions` logged in as `user1@example.com / password123`:
- Section appears above the market list with a count, collapses/expands on header click.
- Expanding an open position shows the trade card; trading updates the section without reload.
- Logged out: no section.

If user1 has no positions, seed one first:

```bash
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c \
  "INSERT INTO user_shares (user_id, event_id, yes_shares)
   SELECT u.id, e.id, 5 FROM users u, events e
   WHERE u.email = 'user1@example.com' AND e.outcome IS NULL AND e.hidden_at IS NULL
   ORDER BY e.id DESC LIMIT 1
   ON CONFLICT (user_id, event_id) DO UPDATE SET yes_shares = 5"
```

(Remove it after checking: `DELETE FROM user_shares WHERE yes_shares = 5 AND total_staked_ledger = 0 AND user_id = (SELECT id FROM users WHERE email = 'user1@example.com')`.)

- [ ] **Step 6: Commit**

```bash
git add frontend-solid/src/components/predictions/EventsList.jsx frontend-solid/src/styles.css
git commit -m "feat(predictions): persistent My Positions section on the Markets tab

All invested markets always visible above the browsable list — including
junk-hidden ones (Unlisted tag) and markets resolved within 7 days
(muted, settled outcome badge). Replaces the dropdown my-positions filter,
whose re-fetch through GET /events silently dropped hidden markets.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: E2E coverage

**Files:**
- Test: `tests/e2e/my-positions-section.spec.js` (new)

**Interfaces:**
- Consumes: CSS classes from Task 3 (`my-positions-card`, `event-unlisted-tag`, `event-settled-tag`, `position-resolved`, `event-list-item`), enriched endpoint from Task 2, `resolved_at` from Task 1.

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/my-positions-section.spec.js`:

```js
// E2E: My Positions section on #predictions. The section must show every
// invested market — including junk-hidden ones the browse list filters out —
// plus recently resolved markets, and drop stale resolutions.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('my positions section', () => {
  const stamp = Date.now();
  const titles = {
    open: `E2E pos open ${stamp}`,
    hidden: `E2E pos hidden ${stamp}`,
    resolved: `E2E pos resolved ${stamp}`,
    stale: `E2E pos stale ${stamp}`
  };
  let userId;
  const eventIds = {};

  test.beforeAll(() => {
    userId = Number(psql(`SELECT id FROM users WHERE email = 'user1@example.com'`));
    // Trading requires Tier 2 (phone verified); restore tier 1 in afterAll.
    psql(`UPDATE users SET verification_tier = 2 WHERE id = ${userId}`);

    // The open event is multiple_choice so the buy flow can reuse the
    // selectors proven in multi-outcome-trading.spec.js.
    eventIds.open = Number(psql(
      `INSERT INTO events (title, closing_date, event_type, liquidity_b)
       VALUES ('${titles.open}', NOW() + INTERVAL '7 days', 'multiple_choice', 5000) RETURNING id`
    ));
    const o1 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventIds.open}, 'choice_1', 'Alpha', 0) RETURNING id`
    ));
    const o2 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventIds.open}, 'choice_2', 'Beta', 1) RETURNING id`
    ));
    psql(
      `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
       VALUES (${eventIds.open}, ${o1}, 0, 0.5), (${eventIds.open}, ${o2}, 0, 0.5)`
    );
    // staked_ledger 0: the seed never debited the user's balance, so the
    // afterAll refund (which credits staked_ledger back) must not count it.
    psql(
      `INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
       VALUES (${userId}, ${eventIds.open}, ${o1}, 4.0, 0)`
    );
    eventIds.hidden = Number(psql(
      `INSERT INTO events (title, closing_date, hidden_at, hidden_reason)
       VALUES ('${titles.hidden}', NOW() + INTERVAL '7 days', NOW(), 'llm: e2e junk') RETURNING id`
    ));
    eventIds.resolved = Number(psql(
      `INSERT INTO events (title, closing_date, outcome, resolved_at)
       VALUES ('${titles.resolved}', NOW() - INTERVAL '3 days', 'resolved_yes', NOW() - INTERVAL '2 days') RETURNING id`
    ));
    eventIds.stale = Number(psql(
      `INSERT INTO events (title, closing_date, outcome, resolved_at)
       VALUES ('${titles.stale}', NOW() - INTERVAL '20 days', 'resolved_no', NOW() - INTERVAL '10 days') RETURNING id`
    ));

    psql(`INSERT INTO user_shares (user_id, event_id, yes_shares) VALUES (${userId}, ${eventIds.hidden}, 5)`);
    psql(
      `INSERT INTO market_updates (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until)
       VALUES (${userId}, ${eventIds.resolved}, 0.5, 0.55, 10, 18, 'yes', NOW()),
              (${userId}, ${eventIds.stale}, 0.5, 0.55, 10, 18, 'yes', NOW())`
    );
  });

  test.afterAll(() => {
    const ids = Object.values(eventIds).filter(Boolean).join(',');
    if (ids) {
      // Refund whatever the in-test buy staked before the cascade wipes the
      // share rows (same leak-proofing as multi-outcome-trading.spec.js).
      psql(`UPDATE users u
            SET rp_balance_ledger = rp_balance_ledger + s.staked_ledger,
                rp_staked_ledger = rp_staked_ledger - s.staked_ledger
            FROM user_outcome_shares s
            WHERE s.event_id IN (${ids}) AND s.user_id = u.id AND s.staked_ledger > 0`);
      psql(`DELETE FROM market_outcome_updates WHERE event_id IN (${ids})`);
      psql(`DELETE FROM market_updates WHERE event_id IN (${ids})`);
      psql(`DELETE FROM events WHERE id IN (${ids})`); // cascades share rows
    }
    psql(`UPDATE users SET verification_tier = 1 WHERE id = ${userId}`);
  });

  test('section shows open, hidden, and recently resolved holdings', async ({ page }) => {
    await page.goto(`${BASE}/#login`);
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });

    await page.goto(`${BASE}/#predictions`);
    const section = page.locator('.my-positions-card');
    await expect(section).toBeVisible({ timeout: 20000 });

    // Open position renders the seeded holding and a live trade card.
    const openRow = section.locator('.event-list-item', { hasText: titles.open });
    await expect(openRow).toBeVisible();
    await expect(openRow.locator('.event-category')).toContainText('Alpha ×4.0');
    await openRow.locator('.event-list-item-row').click();
    const card = openRow.locator('.outcome-market-card');
    await expect(card).toBeVisible({ timeout: 10000 });

    // Buy inside the section — the section must reflect the new shares
    // without a page reload (handleTradeRefresh reloads positions).
    await card.locator('.outcome-row', { hasText: 'Alpha' }).click();
    await card.locator('.stake-input').fill('100');
    await card.getByRole('button', { name: /^buy$/i }).click();
    await expect
      .poll(async () => openRow.locator('.event-category').textContent(), { timeout: 15000 })
      .not.toContain('Alpha ×4.0');

    // Junk-hidden market still shows, marked Unlisted — and stays out of the
    // browsable list below.
    const hiddenRow = section.locator('.event-list-item', { hasText: titles.hidden });
    await expect(hiddenRow).toBeVisible();
    await expect(hiddenRow.locator('.event-unlisted-tag')).toBeVisible();
    await expect(
      page.locator('.events-list-card:not(.my-positions-card) .event-list-item', { hasText: titles.hidden })
    ).toHaveCount(0);

    // Recently resolved: muted, settled badge, no expansion.
    const resolvedRow = section.locator('.event-list-item.position-resolved', { hasText: titles.resolved });
    await expect(resolvedRow).toBeVisible();
    await expect(resolvedRow.locator('.event-settled-tag')).toContainText(/YES/i);
    await resolvedRow.locator('.event-list-item-row').click();
    await expect(resolvedRow.locator('.event-row-expanded')).toHaveCount(0);

    // Resolved 10 days ago: gone.
    await expect(section.locator('.event-list-item', { hasText: titles.stale })).toHaveCount(0);
  });

  test('logged out shows no section', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`);
    await page.waitForSelector('.events-simple-list li', { timeout: 20000 });
    await expect(page.locator('.my-positions-card')).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Reset test users and run the spec**

```bash
./tests/e2e/reset-test-users.sh
npx playwright test tests/e2e/my-positions-section.spec.js
```

Expected: 2 tests PASS. (If login fails, re-run reset-test-users.sh — it restores user1/user2.)

- [ ] **Step 3: Run the neighboring predictions specs to catch regressions**

```bash
npx playwright test tests/e2e/predictions-pagination.spec.js tests/e2e/predictions-tabs.spec.js tests/e2e/multi-outcome-trading.spec.js
```

Expected: PASS (the removed my-positions dropdown option is not referenced by these specs; if one fails on it, update the assertion in that spec).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/my-positions-section.spec.js
git commit -m "test(e2e): my-positions section — hidden markets visible, stale resolutions dropped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
