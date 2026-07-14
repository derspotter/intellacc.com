# Tradeable Imported Markets: MC Backfill + Numeric Distribution Trading

**Date:** 2026-07-14
**Status:** Approved (user chose Level 3 for numerics; Codex GPT-5.6 consultation
in `scratchpad/codex-continuous-lmsr.md`, key content mirrored here)

## Problem

249 imported Metaculus markets are permanently untradeable: the fetcher drops
the API's `options` (multiple choice) and `scaling` (numeric) fields, so
`seed_outcomes_if_missing` never seeds `event_outcomes`. 78 multiple_choice +
171 numeric events show "outcomes are not configured yet" forever, and they
clutter listings as dead ends. Additionally, resolution_sync skips MC/numeric
entirely, and numeric questions have no trading model at all.

## Decision

- **Phase A (ship first):** extract MC options in the Metaculus fetcher
  (backfill via existing sync), hide unconfigured multi-outcome markets from
  listings, extend resolution_sync with MC label matching.
- **Phase B (Level 3):** numeric markets trade as **dense-bin LMSR** (50 bins)
  with a **distribution editor UX** — users place a belief curve; one atomic
  vector trade moves the market toward it. No user-visible buckets-as-buttons.

## Phase A

### A1. Metaculus fetcher extracts outcome metadata
`prediction-engine/src/metaculus.rs`: extend `MetaculusQuestion` to
deserialize `options` (list of `{label}` for multiple_choice) and, for
numeric: `scaling.range_min`, `scaling.range_max`, `scaling.zero_point`,
`open_lower_bound`, `open_upper_bound`, `unit`. (Live-verified 2026-07-14:
question 42156 = post 42366, `scaling: {range_min: 0, range_max: 10,
zero_point: null}`.) `convert_to_imported_market` populates
`ImportedMarket.outcomes` for multiple_choice (one `ImportedOutcome` per
option, API order, keys `choice_N`). Numeric metadata is carried on
`ImportedMarket` (new fields) for Phase B; numeric events get NO outcomes in
Phase A.

Backfill: `seed_outcomes_if_missing` already runs on both create and merge
paths — the next `/metaculus/sync` seeds the 78 existing MC events. No script.

### A2. Listings hide unconfigured multi-outcome markets
`backend predictionsController.getEvents`: exclude events with
`event_type IN ('multiple_choice','numeric','date','discrete')` that lack
>= 2 active `event_outcomes` rows (`NOT EXISTS` subquery). Detail pages stay
reachable by id (existing "not configured" message); MyPositions unaffected
(positions query, not listings). Weekly assignment selection must also skip
unconfigured events (verify; add the same predicate if needed).

### A3. resolution_sync resolves multiple_choice
For resolved source MC questions: match the source's resolution label to our
`event_outcomes.label` (case-insensitive, trimmed). Match → resolve via the
existing multi-outcome resolution path (same as AdminMarketResolution). No
match → log warning, leave for admin. Numeric resolution is Phase B.

## Phase B: numeric distribution trading

### Market model (engine)
- Categorical LMSR over **50 equal-width bins** on `[range_min, range_max]`,
  v1 supports **bounded linear** questions only (`zero_point == null`, both
  bounds closed). Log-scaled/open-bound questions stay unconfigured (hidden by
  A2) — explicit follow-up.
- Bin layout immutable once trading begins. Uniform initial mass (1/50).
- Liquidity policy: `b` derived from an explicit max-subsidy budget, not
  copied from `liquidity_b`: `b_numeric = NUMERIC_MAX_SUBSIDY_RP / ln(50)`,
  env-configurable, default `NUMERIC_MAX_SUBSIDY_RP = 3466` (matches today's
  binary subsidy; gives b ≈ 886). Stored per-event at seed time in
  `numeric_market_config`.

### Vector trade primitive (engine core)
New in `lmsr_multi_core.rs`:
`apply_vector(q: &[f64], delta_q: &[f64], b: f64) -> cost` computing ONE cost
difference `C(q+Δq) − C(q)` with log-sum-exp stability; the executor validates
the whole resulting vector and commits atomically. Never loops the
single-outcome path.

### Bundle math (verified independently; Codex formulas)
Given market mass `p`, user target mass `u` (floored at 1e-9, renormalized),
`d_i = b·ln(u_i/p_i)`:
- Buy-only exact move: `Δq_i = d_i − min_j d_j`; cost `S(1) = −min_i d_i`.
- Budget-limited: `Δq_i(α) = α·(d_i − min_j d_j)`, resulting prices
  `∝ p_i^{1−α}·u_i^α`, cost
  `S(α) = −α·min_i d_i + b·ln Σ_i p_i^{1−α}u_i^α`.
  Solve (bisection on monotone S) for the largest α whose ledger-rounded cost
  ≤ the user's integer budget. Cap at α=1 (never buy complete sets).
- UI copy: "trade size" / "market influence" — NOT "Kelly".

### Endpoints (engine, proxied by backend with auth + tier gate)
- `GET  /events/:id/numeric-quote?budget=X&target=<csv or json>` → preview:
  α, cost, per-bin deltas, post-trade distribution, market_version.
- `POST /events/:id/numeric-trade` `{target_distribution, budget_ledger,
  max_cost_ledger, market_version}` → atomic execute. Stale market_version →
  409 with fresh quote. One row lock (existing event-row lock), one bulk
  upsert (UNNEST) for all bin states, ONE ledger rounding of total cost,
  one `distribution_trades` row + legs, per-bin shares into
  `user_outcome_shares` (share store unchanged → existing settlement works).
- `POST /events/:id/numeric-sell` → atomically liquidate the user's ENTIRE
  numeric position (vector sale, one cost, one credit). Partial rebalance
  deferred.

### Schema (backend migration)
- `numeric_market_config(event_id PK, range_min, range_max, zero_point,
  open_lower_bound, open_upper_bound, bin_count, transform, binning_version,
  b_numeric, created_at)`.
- `distribution_trades(id, user_id, event_id, total_cost_ledger BIGINT
  (signed; negative = sale), alpha, target_distribution JSONB,
  pre_market_version, post_market_version, hold_until, created_at)`.
- `distribution_trade_legs(trade_id, outcome_id, shares_delta)`.
- One optimistic-concurrency counter per market:
  `numeric_market_config.numeric_market_version BIGINT NOT NULL DEFAULT 0`,
  incremented on every executed trade; quotes carry it, executes verify it.
- Numeric trades do NOT write `market_outcome_updates` (50-row noise); the
  activity feed for numeric markets reads `distribution_trades`.

### Invariants (must land BEFORE numeric trading)
Generalize the engine invariant checkers (currently binary-only, summing
`user_shares` and ignoring `user_outcome_shares`): staked and post-resolution
invariants include multi-outcome + numeric positions. Property tests:
probabilities finite/sum to 1; quoted cost == executed ledger cost;
buy-then-sell at unchanged state is ledger-neutral (≤1 micro-RP drift);
permutation independence; no negative holdings; concurrent trades serialize;
resolution clears numeric positions and staked ledger exactly.

### Seeding + resolution
- `seed_outcomes_if_missing` path extended: numeric + bounded linear +
  unresolved → create 50 bins (labels "lo–hi" with unit) + uniform states +
  `numeric_market_config` row. Next sync backfills eligible existing events.
- resolution_sync numeric: source resolution value → the bin whose
  `[lower_bound, upper_bound)` contains it (last bin closed on both ends);
  resolve via categorical payout. Out-of-range value → log, leave for admin.

### Frontend
- New `DistributionMarketCard.jsx` (van skin, styles.css tokens), dispatched
  from `MarketDetailView`/`MyPositions` for `event_type === 'numeric'` with
  outcomes; MC keeps `OutcomeMarketCard`.
- Hand-rolled SVG: market distribution as filled area; user target as line;
  after-trade preview overlay while adjusting.
- Input model: three handles — **low / center / high** (P10/P50/P90) as
  draggable markers + numeric inputs; presets narrow/medium/wide; budget
  input (RP) with live quote (debounced `numeric-quote`); copy like
  "80% chance between 3.2 and 6.1".
- Curve fit: split-normal from (low, center, high); integrate its CDF over
  bin edges to get `u_i` (never sample PDF at centers).
- Position display: "your shares by bin" as a thin overlay + total cost basis
  and current liquidation value (from quote of full sale); Sell button =
  numeric-sell.
- Logged-out / tier-gated states mirror OutcomeMarketCard behavior.

### Out of scope (explicit)
- Log-scaled (`zero_point != null`), open-bound, `date`/`discrete` questions
  (remain hidden by A2).
- Partial position rebalancing (only full sell in v1).
- True Kelly sizing; complete-set purchases.
- Polymarket/Kalshi fetcher outcomes.
- Continuous CDF settlement (settlement is by winning bin).

## Testing
- Rust: unit tests for apply_vector cost math, α-solve, bin generation;
  property tests listed under Invariants (proptest or seeded loops).
- Backend jest: listing filter (A2), proxy auth/tier gates, migration shape.
- E2E (Playwright, solid-local): MC market from backfilled import trades via
  OutcomeMarketCard; numeric market seeds 50 bins, DistributionMarketCard
  places a budgeted trade, market curve moves, position shows, full sell
  returns RP; unconfigured numeric (open-bound) stays hidden from list but
  renders "not configured" detail page.
- Deploy order: backend (migrations) BEFORE engine rebuild (engine reads new
  tables); frontend last; then manual `/metaculus/sync` and verify a real
  numeric market end-to-end on intellacc.de.
