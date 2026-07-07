# My Positions Section — Design

**Date:** 2026-07-07
**Branch:** predictions-declutter-tabs
**Status:** Approved pending user spec review

## Problem

The predictions page never reliably shows the user's own holdings:

1. Positions are only reachable via a "My Positions" option buried in the
   filter dropdown on the Markets tab — nothing is visible by default.
2. Even that view is broken: it extracts event ids from
   `GET /users/:id/positions` and re-fetches them through `GET /events`,
   which unconditionally applies `hidden_at IS NULL`
   (`predictionsController.js` `getEvents`). If Gemma later junk-flags a
   market the user invested in, the position silently disappears.
3. The re-fetch is capped at 500 ids (server-side `limit` cap) with no paging.
4. Resolved markets vanish instantly: settlement **deletes** the
   `user_shares` / `user_outcome_shares` rows (`lmsr_api.rs`
   `resolve_event*_transaction`, post-resolution invariant enforces zero
   rows), so the user never sees how a market they invested in settled.

## Requirement (user-approved)

A persistent **My Positions** section at the top of the Markets tab that
always shows **all** markets the user has invested in:

- **Open positions** — every market where the user currently holds shares
  (binary or multi-outcome), including junk-hidden markets.
- **Recently resolved** — markets the user had invested in that resolved
  within the last 7 days, shown muted with their settled outcome, then
  dropping out.

## Approach (Option A — enrich the positions endpoint)

One round trip: extend `GET /users/:id/positions` to return card-ready event
data directly. The section never touches `getEvents`, so the junk filter,
the 500-id cap, and the open-only default cannot hide a position.

## Backend

### Migration: `events.resolved_at`

New migration in `backend/migrations/`:

```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
-- Backfill approximation for already-resolved events so the 7-day window
-- has data on day one (updated_at is a rough proxy; acceptable).
UPDATE events SET resolved_at = updated_at WHERE outcome IS NOT NULL AND resolved_at IS NULL;
```

### Engine: stamp `resolved_at`

Both resolution transactions in `prediction-engine/src/lmsr_api.rs` set it:

- Binary path (`UPDATE events SET outcome = $1 WHERE id = $2`, ~line 1344)
  → add `resolved_at = NOW()`.
- Outcome path (`UPDATE events SET outcome = $1, resolution_outcome_id = …`,
  ~line 1429) → add `resolved_at = NOW()`.

During implementation, grep for any other site that sets `events.outcome`
(backend admin/legacy resolution, resolution sync) and stamp those too.

### Enriched `getUserPositions` (`backend/src/controllers/userController.js`)

The existing query already JOINs `events` and UNIONs binary + multi-outcome
shares. Changes:

1. **Add event fields to both existing branches:** `outcome`,
   `resolution_outcome_id`, `resolved_at`, `hidden_at`, `liquidity_b`,
   `q_yes`, `q_no`, `details` — enough for `MarketEventCard` /
   `OutcomeMarketCard` to render without a second fetch. Add a
   `position_kind` discriminator: `'open'`.
2. **Add a third UNION branch — recently resolved:** events with
   `outcome IS NOT NULL AND resolved_at > NOW() - interval '7 days'` where
   the user has any trade in `market_updates` or `market_outcome_updates`
   (`EXISTS` per table, deduped via `UNION` of event ids). Share columns
   NULL, `position_kind: 'resolved'`.
3. **No hidden filter anywhere** — hidden markets are included deliberately;
   the payload carries `hidden_at` so the UI can mark them.
4. Keep the own-positions-only auth check. Remove the leftover
   `console.log` debug lines while there.

Response stays a flat array of rows (one per binary position, one per
outcome holding, one per resolved event); the frontend groups by `event_id`.

## Frontend (`frontend-solid/src/components/predictions/EventsList.jsx`)

### New section

A `MyPositions` section rendered inside `EventsList` above the
"Open Questions" header (EventsList already owns the `userPositions`
signal and the trade-refresh cycle — no new state plumbing):

- Collapsible header `MY POSITIONS (n)` counting distinct open markets;
  expanded by default. Not rendered at all when logged out or when the
  positions payload is empty (no open and no recently-resolved rows) — no
  empty-state placeholder cluttering the page.
- Rows grouped by `event_id`. Multi-outcome rows for the same event merge
  into one entry listing held outcomes. Same visual row pattern as the main
  list (title, prob bar, closing date, expand-in-place) reusing the existing
  `event-list-item` CSS classes.
- Expanding a row shows the same trading cards as the main list:
  `OutcomeMarketCard` for `multiple_choice`/`numeric`, `MarketEventCard`
  otherwise, wired to the existing `handleTradeRefresh` (which already
  reloads both events and positions).
- **Ordering:** open positions by `closing_date` ascending (most urgent
  first), then resolved rows by `resolved_at` descending.
- **Resolved rows** (`position_kind === 'resolved'`): muted style, settled
  outcome badge (YES/NO or winning outcome label), no trading card on
  expand — resolved markets are not tradable.
- **Junk-hidden markets** (`hidden_at` set): small "unlisted" tag so it's
  clear why the market isn't in the browsable list below.

### Cleanup

- Remove the `my-positions` option from the filter dropdown and its branch
  in `loadEvents` (the ids re-fetch path) — the section supersedes it.
- Keep the "Position" tag on main-list rows (`positionEventIds`) — cheap
  and still useful when scrolling the full list.

## Error handling

- Positions fetch failure: section shows a one-line error with a retry
  button; the main market list is unaffected (independent load paths).
- Logged-out: section not rendered (matches current `authed()` gating).
- A resolved event whose `resolution_outcome_id` no longer resolves to a
  label (outcome deleted): fall back to the raw `outcome` string.

## Testing

- **Backend** (`backend/test/`): endpoint test covering — binary open
  position, multi-outcome open position, junk-hidden market with a position
  (must be returned, `hidden_at` populated), market resolved 2 days ago with
  a prior trade (returned as `position_kind: 'resolved'`), market resolved
  10 days ago (excluded), other users' positions (403).
- **E2E** (`tests/e2e/`): seed a position for a test user, junk-hide the
  event via SQL, assert the market still renders in the My Positions
  section with the "unlisted" tag; buy → assert the section updates without
  reload; resolved-market row shows outcome badge and no trade controls.
- **Engine**: extend the existing resolution integration test to assert
  `resolved_at` is stamped.

## Out of scope / deferred

- Per-market realized P&L on resolved rows (payout ledger round-trip is an
  existing deferred item; resolved rows show the outcome only).
- Paging inside the section (positions counts are small; revisit if a user
  exceeds a few hundred open positions).
- The legacy `predictions` table / assigned predictions — the weekly
  assignment card already covers that surface.
