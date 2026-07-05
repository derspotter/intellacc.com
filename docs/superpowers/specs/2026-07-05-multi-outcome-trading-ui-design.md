# Multi-Outcome Trading UI — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorming complete)
**Branch:** worktree-pane2-work (rename before merge, e.g. `multi-outcome-trading-ui`)

## Problem

The platform has 525 `multiple_choice` and 160 `numeric` events in production, and a
complete multi-outcome LMSR backend (schema `20260322_add_multi_outcome_lmsr_schema.sql`,
N-outcome core `prediction-engine/src/lmsr_multi_core.rs`, buy endpoint
`POST /events/:id/update-outcome`, outcome-based resolution). The Solid frontend ignores
all of it: non-binary events render through the binary `MarketEventCard`, showing a bogus
yes/no widget whose trades the engine rejects ("Use outcome-based endpoint for non-binary
markets", `lmsr_api.rs:291`). Two genuine backend gaps also block a full trading loop:

1. **No multi-outcome sell anywhere in the stack.** Engine `sell_shares` is binary-only
   (`Side::{yes,no}`).
2. **Positions endpoint is binary-only.** `GET /users/:id/positions`
   (`backend/src/controllers/userController.js:1261`) reads only `user_shares`, never
   `user_outcome_shares`.

## Scope (all approved)

1. Trading UI for `multiple_choice` and `numeric` (bucketed) markets — full buy **and sell**.
2. Engine + backend support for outcome-level selling.
3. Positions endpoint unions multi-outcome holdings.
4. Admin resolution UI for outcome/numeric resolution.
5. Creation UI: extend the existing question submission flow with event type + outcomes editor.

## Architecture Decision

**Separate card + shared parts.** New `OutcomeMarketCard.jsx` handles
`multiple_choice`/`numeric`; lists dispatch by `event_type`. Genuinely shared pieces
(stake input, verification-error handling, position formatting) are extracted into small
shared modules; the extraction is move-only for `MarketEventCard.jsx` (705 lines, the
money path for 2,008 binary events) — zero behavior change there.

Rejected: branching inside `MarketEventCard` (grows an already-large file, every change
risks the binary money path); unifying binary onto the outcomes array (binary trades use
a different endpoint/`target_prob` model, so unification is superficial while rewriting a
working money path).

**Trade UX:** select-then-trade — radio list of outcomes with live prices, one trade
panel below bound to the selected outcome (mirrors the existing binary panel pattern).

## 1. Engine changes (`prediction-engine/`)

### `POST /events/:id/sell-outcome` (new)

Request: `{ user_id, outcome_id, amount }` (shares to sell).
Handler `sell_outcome_shares` in `lmsr_api.rs`, mirroring the binary `sell_shares`
transaction structure:

- Validate market is non-binary (else reject with "use /sell"), open, and the user holds
  ≥ `amount` shares in `user_outcome_shares` with `hold_until` respected.
- Payout = `C(q) − C(q − Δ)` via the existing `lmsr_multi_core::cost`.
- Atomically: decrement `user_outcome_shares.shares` and `staked_ledger`
  proportionally, update `event_outcome_states` q-values, credit user ledger balance
  (RP), journal a `market_outcome_updates` row (negative-stake style, matching binary
  sell journaling).
- Response: binary `SellResult` fields (`payout`, `new_prob` of the sold outcome,
  `current_cost_c`) **plus** refreshed `outcomes: [MarketOutcomeView]` so the UI
  repaints all prices in one round trip.

### Tests (Rust)

- Round-trip buy→sell yields payout ≤ stake (no free money, LMSR invariant).
- Reject: over-holdings, binary market, unknown `outcome_id`, closed market.
- Probabilities re-normalize (sum ≈ 1) after sells.

## 2. Backend changes (`backend/`)

### `POST /events/:eventId/sell-outcome` proxy (new, `routes/api.js`)

Middleware chain identical to the existing binary sell route:
`authenticateJWT + requirePhoneVerified + requireScope('market:trade')`.
Forwards `{ user_id, outcome_id, amount }` to the engine; on success broadcasts socket
`marketUpdate` with `action: 'sell-outcome'` + outcomes payload (same shape as the
existing `stake-outcome` broadcast at `api.js:724-733`).

### `getUserPositions` union (`controllers/userController.js:1261`)

Union `user_outcome_shares` joined to `event_outcomes` into the result set. Multi-outcome
rows carry `event_id, outcome_id, label, shares, staked_ledger` (+ event title/type as
the binary rows do). Binary rows keep their exact current shape — additive change.

### Events list payload

Add `resolution_outcome_id` to the SELECT in `getEvents`/`getEventById`
(`predictionsController.js:464,511`) so the admin unresolved filter works (see §4).

### No changes needed

- `POST /events/:id/update-outcome` proxy exists (`api.js:679`) and is correct.
- `GET /events/:id/market` proxy exists (`api.js:408`), returns outcomes array.
- `createEvent` already accepts `event_type`, `outcomes`, `numeric_buckets` (Tier 3).
- `PATCH /events/:id` resolution already dispatches on `outcome_id` /
  `numerical_outcome` / `outcome`.

### Tests (jest, in-container)

- `sell-outcome`: auth chain (401/403 tiers), forwarding, socket emit, engine error
  pass-through.
- `getUserPositions`: returns unioned outcome rows; binary-only users unaffected.
- `update-outcome` proxy: first coverage (currently untested).

## 3. Frontend trading card (`frontend-solid/`)

### `services/api.js` additions

- `getMarketState(eventId)` → `GET /events/:id/market`
- `updateOutcome(eventId, { stake, outcome_id })` → `POST /events/:id/update-outcome`
- `sellOutcome(eventId, { outcome_id, amount })` → `POST /events/:id/sell-outcome`

### `components/predictions/OutcomeMarketCard.jsx` (new)

Rendered when `event_type ∈ {multiple_choice, numeric}`. Dispatch is a tiny
`event_type`-based ternary in the card-rendering spots (`EventsList.jsx`,
`MarketQuestionHub.jsx`, `GroupMarkets.jsx`); nothing else changes in the lists.

Data flow:
- On mount, `getMarketState(eventId)` fetches outcomes (per-outcome `prob`, `label`,
  `lower_bound`/`upper_bound`). Lazy per card, no list-level fan-out.
- Positions from the same `getUserPositions` call the binary card uses (now including
  `outcome_shares` rows).
- After each buy/sell, the response's refreshed `outcomes` array repaints prices;
  socket `marketUpdate` with `stake-outcome`/`sell-outcome` refreshes other users'
  open cards via the existing `onStakeUpdate` path.

UI (approved select-then-trade shape):
- Radio list of outcomes: label (numeric buckets formatted as bound range, open-ended
  ends as `<x` / `≥x`), probability %, user's share count in that outcome if > 0.
- One trade panel bound to the selected outcome: stake input, BUY, SELL (SELL enabled
  only when holdings > 0 in the selected outcome; amount capped at holdings). Same
  ledger-unit conventions and stake clamps as the binary panel.
- Position summary: aggregate holdings across outcomes with unrealized value
  `Σ shares_i × prob_i − staked`.
- Verification gating identical to binary card: catch 403 `ApiError`, surface
  `required_tier` via `onVerificationNotice`.

Shared extraction: stake input, verification-error handling, and position formatting
move to a shared module (e.g. `components/predictions/marketCardShared.js`), consumed by
both cards. Move-only refactor for the binary card.

Styling: existing `.event-card` / `.market-stats` / `.trade-direction` class
conventions so terminal and van skins inherit.

## 4. Admin resolution (`AdminMarketResolution.jsx`)

- Binary events: current Yes/No toggle untouched.
- `multiple_choice`: fetch outcomes via `getMarketState`, outcome dropdown, resolve with
  `{ outcome_id }`.
- `numeric`: number input, resolve with `{ numerical_outcome }` (engine maps value to
  bucket).
- `api.events.resolve` extended to pass `outcome_id` / `numerical_outcome` alongside
  legacy `outcome`.
- Unresolved filter becomes: no `outcome` AND no `resolution_outcome_id` AND no
  `numerical_outcome`.

## 5. Creation UI (question submission flow, `MarketQuestionHub.jsx`)

- Event-type selector: Binary (default, form unchanged) / Multiple choice / Numeric
  buckets.
- Multiple choice: dynamic outcomes editor — 2 to 10 text rows, add/remove, client-side
  checks for empty/duplicate labels (backend `normalizeOutcomeRows` re-validates
  authoritatively).
- Numeric: bucket-boundary editor (ordered numbers → N+1 buckets including open-ended
  ends), matching `createEvent`'s `numeric_buckets` validation.
- Submission passes `event_type` + `outcomes`/`numeric_buckets` through the existing
  create call; gating unchanged (backend enforces Tier 3 as today).

## Error handling

- Trade panel surfaces engine rejections verbatim via the existing error banner path
  (insufficient shares, hold-period, market closed, endpoint mismatch — backend already
  forwards engine messages).
- `getMarketState` failure → degraded read-only card (title + "prices unavailable,
  retry" button), never a broken widget.
- `multiple_choice` event with zero outcome rows (85 of 525 today) → "market not yet
  configured", no trade panel.

## Testing summary

- **Engine:** Rust unit/integration tests for sell math and guards (§1).
- **Backend:** jest tests for sell-outcome proxy, positions union, update-outcome proxy (§2).
- **Frontend/E2E:** Playwright — create a multiple_choice event, buy an outcome as
  user1, verify prices shift, sell, admin-resolve to an outcome, verify payout. Runs
  against the solid-local stack.

## Out of scope

- Kelly suggestions for multi-outcome markets (binary-only endpoint stays as is).
- Backfilling outcomes for the 85 outcome-less multiple_choice events (separate data
  task; UI degrades gracefully).
- Forecast (non-market) prediction flow for multi-outcome events.
- Feed/ranking changes; non-binary events already appear in lists.
