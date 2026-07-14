# Numeric Markets Implementation Plan (MC backfill + distribution trading)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make imported Metaculus markets tradeable: multiple-choice via outcome backfill (Phase A), numeric via 50-bin LMSR with a distribution-editor UX (Phase B). Hide unconfigured markets from listings; auto-resolve MC and numeric imports.

**Architecture:** See spec `docs/superpowers/specs/2026-07-14-numeric-markets-design.md` (binding) and the Codex consultation `2026-07-14-numeric-markets-codex-consult.md` (rationale). Engine work in Rust (Axum + SQLx), backend proxies in Express, UI in SolidJS with hand-rolled SVG.

**Tech Stack:** Rust (prediction-engine, Docker build only), Express, PostgreSQL, SolidJS, Playwright.

## Global Constraints

- The spec is binding; where this plan and the spec disagree, the spec wins; flag the conflict.
- Engine builds ONLY in Docker: `docker compose up -d --build prediction-engine` (repo root). Rust unit tests: `docker run --rm -v /var/opt/docker/intellacc.com/prediction-engine:/app -w /app -v pane2_cargo_registry:/usr/local/cargo/registry -v pane2_cargo_target:/app/target rust:latest cargo test <filter> --lib` (integration tests needing DB are excluded via `--lib`).
- Backend deploy = `docker restart intellacc_backend` (auto-runs migrations); `.env` changes need `docker compose up -d backend`. Backend is source-mounted but does NOT hot-reload.
- E2E from host against solid-local dev (http://localhost:4174), `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` — `-p solid-local` is MANDATORY.
- Backend jest: `docker exec intellacc_backend npx jest test/<file> --runInBand`.
- All frontend CSS in `frontend-solid/src/styles.css`, tokens only, no Tailwind in van-skin components.
- Ledger discipline: round ONE total cost per vector trade to `LEDGER_SCALE` (1e-6 RP), never per-bin; signed BIGINT ledger units everywhere money moves.
- `LEDGER_SCALE` and helpers live in `prediction-engine/src/lmsr_core.rs`.
- Money paths need the invariant tests green before deploy (Task 6 gate).
- This box hosts production. Never touch `intellacc_frontend_solid` except the final deploy step; production verification only via https://intellacc.de.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1 (A1): Metaculus fetcher extracts outcomes + numeric metadata

**Files:**
- Modify: `prediction-engine/src/metaculus.rs` (MetaculusQuestion struct ~line 25, convert_to_imported_market ~line 175)
- Modify: `prediction-engine/src/market_import.rs` (ImportedMarket struct ~line 15: add numeric metadata fields)

**Interfaces:**
- Consumes: Metaculus API `/api/posts/` payloads. Verified live shape: `question.options: [string]` for multiple_choice; `question.scaling: {range_min, range_max, zero_point}`; `question.open_lower_bound`, `question.open_upper_bound`, `question.unit` (may be at question level or inside scaling — verify against live payload for one MC post and one numeric post BEFORE coding; save both payloads as test fixtures under `prediction-engine/src/fixtures/` if a fixtures dir pattern exists, else inline strings in tests).
- Produces: `ImportedMarket.outcomes` populated for multiple_choice (keys `choice_1..N`, labels = option strings, sort_order = API index, bounds NULL). New fields on `ImportedMarket`: `numeric_range_min: Option<f64>`, `numeric_range_max: Option<f64>`, `numeric_zero_point: Option<f64>`, `numeric_open_lower: bool`, `numeric_open_upper: bool`, `numeric_unit: Option<String>` — populated for numeric questions, defaulted elsewhere (all fetchers in market_import.rs must compile: add `..Default` or explicit fields to manifold/polymarket/kalshi constructors).

**Steps:**
- [ ] Red: Rust unit test parsing a real MC post JSON fixture into `ImportedMarket` with N outcomes, and a numeric post fixture into the metadata fields. Run via cargo in Docker; watch fail (fields don't exist).
- [ ] Implement struct + conversion changes; keep `outcomes: Vec::new()` for numeric (Phase B seeds bins, not options).
- [ ] Green: cargo tests pass; `cargo build` clean.
- [ ] Rebuild engine container; trigger `curl -s http://<engine>/metaculus/sync` from inside the network (e.g. `docker exec intellacc_backend curl -s http://prediction-engine:3001/metaculus/sync`); then verify backfill: the count of open multiple_choice events without outcomes drops from 78 toward 0 (some may legitimately lack options upstream — record the residue). SQL check in the report.
- [ ] Commit.

### Task 2 (A2): listings hide unconfigured multi-outcome markets

**Files:**
- Modify: `backend/src/controllers/predictionsController.js` (getEvents WHERE clauses ~line 375; check weekly-assignment event selection — find it via `grep -rn "weekly" backend/src/` — and apply the same predicate if it can pick unconfigured events)
- Test: `backend/test/events_listing.test.js` (extend)

**Interfaces:**
- Produces: listings exclude events where `event_type NOT IN ('binary')` AND fewer than 2 active outcomes. Exact predicate (added to the existing `where` array):
  `(event_type = 'binary' OR EXISTS (SELECT 1 FROM event_outcomes eo WHERE eo.event_id = events.id AND eo.is_active = TRUE GROUP BY eo.event_id HAVING COUNT(*) >= 2))`
  — verify `is_active` column exists on event_outcomes (it's referenced in market_import.rs:416); if not, drop that condition.
- By-id endpoint (`getEventById`) unchanged — unconfigured events stay reachable.

**Steps:**
- [ ] Red: jest — seed an MC event with 0 outcomes and one with 2; listing returns only the configured one; by-id returns both. Watch fail.
- [ ] Implement; green; restart backend; commit.

### Task 3 (A3): resolution_sync resolves multiple_choice

**Files:**
- Modify: `prediction-engine/src/resolution_sync.rs` (currently counts-and-skips MC/numeric — read the whole file first)
- Modify (if needed): `prediction-engine/src/metaculus.rs` / resolution fetch structs to expose the source resolution label for MC questions.

**Interfaces:**
- Consumes: resolved MC posts from the source API (`question.resolution` = the winning option label for MC — verify on a live resolved MC post before coding).
- Produces: for a resolved source MC question matched to our event: find `event_outcomes` row with `LOWER(TRIM(label)) = LOWER(TRIM(resolution))`; on match call the SAME resolution routine the admin multi-outcome path uses (find it: `grep -n "resolve" prediction-engine/src/lmsr_api.rs`, the outcome-id based one). No match → `tracing::warn!` with event id + label, skip. Numeric remains skipped until Task 7.

**Steps:**
- [ ] Red: Rust unit test for the label-matching function (exact, case, whitespace, no-match). Watch fail.
- [ ] Implement; green; rebuild engine; run one resolution sync pass (`curl -s -X POST http://prediction-engine:3001/resolutions/sync` from backend container); report how many MC events resolved and spot-check one in SQL (event outcome set, positions settled).
- [ ] Commit.

### Task 4 (B1): schema migration

**Files:**
- Create: `backend/migrations/20260714_numeric_market_schema.sql`
- Test: `backend/test/numeric_market_schema.test.js`

**Interfaces (exact DDL, binding for later tasks):**
```sql
CREATE TABLE IF NOT EXISTS numeric_market_config (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  range_min DOUBLE PRECISION NOT NULL,
  range_max DOUBLE PRECISION NOT NULL,
  zero_point DOUBLE PRECISION,
  open_lower_bound BOOLEAN NOT NULL DEFAULT FALSE,
  open_upper_bound BOOLEAN NOT NULL DEFAULT FALSE,
  unit TEXT,
  bin_count INTEGER NOT NULL,
  transform TEXT NOT NULL DEFAULT 'linear',
  binning_version INTEGER NOT NULL DEFAULT 1,
  b_numeric DOUBLE PRECISION NOT NULL,
  numeric_market_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS distribution_trades (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  total_cost_ledger BIGINT NOT NULL,          -- signed; negative = sale credit
  alpha DOUBLE PRECISION,                      -- NULL for full-position sells
  target_distribution JSONB,                   -- NULL for sells
  pre_market_version BIGINT NOT NULL,
  post_market_version BIGINT NOT NULL,
  hold_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_distribution_trades_event ON distribution_trades(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_distribution_trades_user ON distribution_trades(user_id);
CREATE TABLE IF NOT EXISTS distribution_trade_legs (
  trade_id BIGINT NOT NULL REFERENCES distribution_trades(id) ON DELETE CASCADE,
  outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
  shares_delta DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (trade_id, outcome_id)
);
```

**Steps:**
- [ ] Red: jest asserting the three tables + key columns exist (information_schema). Fail.
- [ ] Write migration; restart backend (auto-runs); green. Confirm migration filename sorts after existing ones (dated files sort first — follow the repo's migration-ordering convention from `backend/migrations/`, see 20260612 precedent).
- [ ] Commit.

### Task 5 (B2): engine vector math core

**Files:**
- Modify: `prediction-engine/src/lmsr_multi_core.rs` (read fully first; follow its existing style/precision patterns)

**Interfaces (exact, binding):**
```rust
/// C(q) = b * ln(sum exp(q_i/b)), computed via log-sum-exp with max-shift.
pub fn cost_multi(q: &[f64], b: f64) -> f64;
/// One cost difference for a whole vector move; both via stable LSE.
pub fn apply_vector_cost(q: &[f64], delta_q: &[f64], b: f64) -> f64;
/// Current probabilities (existing fn may already do this — reuse).
pub fn probabilities(q: &[f64], b: f64) -> Vec<f64>;
/// d_i = b*ln(u_i/p_i); u floored at 1e-9 and renormalized first.
pub fn target_deltas(p: &[f64], u: &[f64], b: f64) -> Vec<f64>;
/// Buy-only exact bundle: d_i - min(d). Cost equals -min(d) (assert in tests).
pub fn exact_bundle(d: &[f64]) -> Vec<f64>;
/// S(alpha) as in spec; monotone increasing in alpha on [0,1].
pub fn bundle_cost(p: &[f64], u: &[f64], b: f64, alpha: f64) -> f64;
/// Largest alpha in [0,1] with round_to_ledger(bundle_cost) <= budget_ledger.
/// Bisection, 64 iterations, returns (alpha, cost_ledger, delta_q).
pub fn solve_alpha_for_budget(p: &[f64], u: &[f64], b: f64, budget_ledger: i64) -> (f64, i64, Vec<f64>);
/// 50 equal-width bins over [min,max]; returns (lower, upper, label) per bin,
/// labels "lo–hi" trimmed to sensible precision, optional unit suffix.
pub fn linear_bins(range_min: f64, range_max: f64, bin_count: usize, unit: Option<&str>) -> Vec<(f64, f64, String)>;
```

**Test cases (write ALL as failing tests first):**
- `apply_vector_cost(q, exact_bundle(d), b)` ≈ `-min(d)` (1e-9 rel) for random p,u (seeded loop, 1000 draws, n=50).
- New probabilities after exact bundle ≈ u (1e-9).
- `bundle_cost` monotone in α; `S(0)=0`; `S(1)=−min d`.
- `solve_alpha_for_budget`: cost_ledger ≤ budget; α maximal (α+ε would exceed); budget ≥ S(1) → α=1 exactly.
- Permutation independence: shuffling bins and re-solving gives permuted Δq, identical cost.
- Buy-then-inverse-sell at unchanged state: `apply_vector_cost(q, Δq) + apply_vector_cost(q+Δq, −Δq) == 0` exactly in f64 terms ≤1e-9, and ≤1 ledger unit after independent roundings.
- Extreme spans: p with 1e-9 floor mass, u concentrated on one bin — no NaN/inf; log-odds span clamp at 40·b rejects with error (Result type ok).
- `linear_bins(0,10,50,None)`: 50 bins, first (0,0.2), last (9.8,10), contiguous, labels sane.

**Steps:** red (all tests) → implement → green → commit. Pure math, no DB — run with `cargo test --lib` in the rust container.

### Task 6 (B3): engine seeding, endpoints, invariants

**Files:**
- Modify: `prediction-engine/src/market_import.rs` (seed numeric bins + config in/next to `seed_outcomes_if_missing`)
- Modify: `prediction-engine/src/lmsr_api.rs` (three endpoints + invariant generalization)
- Modify: `prediction-engine/src/main.rs` (routes)

**Interfaces:**
- Seeding: numeric + `zero_point==null` + both bounds closed + unresolved + no outcomes → `linear_bins(...,50,...)` into `event_outcomes` (+states at prob 1/50, q=0) + `numeric_market_config` row with `b_numeric = env NUMERIC_MAX_SUBSIDY_RP (default 3466.0) / ln(50)`. Other numeric shapes: skip silently (stay hidden).
- `GET /events/:id/numeric-quote?budget_ledger=<i64>&target=<comma-separated 50 floats>` → `{alpha, cost_ledger, market_version, post_distribution: [f64;50], deltas: [f64;50]}`. Read-only.
- `POST /events/:id/numeric-trade` body `{user_id (from auth header pattern used by existing endpoints — mirror update-outcome's auth), target: [f64;50], budget_ledger, max_cost_ledger, market_version}`:
  transaction: lock event row (mirror the existing `FOR UPDATE` at the update-outcome path), re-check version, recompute quote, `cost_ledger > max_cost_ledger` → 409 `{fresh quote}`; debit user balance ledger (reuse the exact balance-debit statements the multi-outcome buy uses — same table/columns); bulk upsert all 50 `event_outcome_states` via UNNEST; upsert 50 `user_outcome_shares` rows (shares += Δq_i; staked_ledger untouched/0 — joint cost lives on the trade row); insert `distribution_trades` + legs; bump `numeric_market_version`; update `events.market_prob` = NULL-safe no-op (binary column, leave as-is) and `cumulative_stake += cost`. Response mirrors quote + trade id.
- `POST /events/:id/numeric-sell` `{user_id, market_version}`: vector sale of the user's entire holding: Δq = −shares vector; one cost (negative), credit `abs`, zero the share rows, trade row with `alpha NULL, target NULL`. Enforce `holding + Δq >= -1e-9` then canonicalize to exact 0.
- Invariant generalization: find the balance/staked invariant endpoints (`grep -n "invariant" lmsr_api.rs`, ~line 1893 sums only `user_shares`) and include `user_outcome_shares` (shares valued at current state prices for exposure checks) and `distribution_trades` net cost in staked accounting. Keep the existing binary semantics untouched — additive terms only.
- Resolution payout: verify the existing categorical resolve routine pays `user_outcome_shares` of the winning outcome and refunds nothing extra for numeric (staked_ledger per bin is 0 by design — confirm the payout math doesn't rely on per-outcome staked_ledger; if it does, adapt payout for numeric events to use distribution_trades totals; document what you find in the report).

**Steps:**
- [ ] Red where unit-testable (α/quote math already covered in Task 5; write handler-level tests only if the file has a pattern for them — otherwise verification is live-exercise below).
- [ ] Implement; `cargo build` + `cargo test --lib` green; rebuild engine container.
- [ ] Live verification (against the real stack, test user): seed one numeric market via sync; from backend container curl quote (uniform target sanity: α... budget 0 → α 0), then a small real trade for E2E user1 (tier 2, known balance): assert cost within budget, state rows changed, version bumped, second stale-version trade 409s, full sell returns credit, buy-then-sell drift ≤ 1 ledger unit (SQL). Run the LMSR invariant endpoints and confirm green. Paste all outputs in the report.
- [ ] Commit.

### Task 7 (B3b): numeric resolution in resolution_sync

**Files:** `prediction-engine/src/resolution_sync.rs`

**Interfaces:** resolved numeric source question → parse resolution value (f64; verify live payload field for a resolved numeric post) → winning bin = the row with `lower_bound <= v < upper_bound` (final bin inclusive upper) → existing categorical resolve. Out of range/unparseable → warn + skip. Rust unit test for the bin-picker (edges: exact boundary, min, max, out-of-range).

**Steps:** red → implement → green → rebuild → run sync pass → report counts → commit.

### Task 8 (B4): backend proxies

**Files:**
- Modify: `backend/src/routes/api.js` (mirror the existing outcome-trading proxy patterns — see `outcome_trading_proxy.test.js` for the auth/tier expectations)
- Test: `backend/test/numeric_trading_proxy.test.js`

**Interfaces:**
- `GET  /api/events/:id/numeric-quote` — authenticated, passes through.
- `POST /api/events/:id/numeric-trade` — authenticated + SAME tier gate as existing trading routes (find it: the middleware/check used by the outcome-update proxy), injects user_id from JWT, never trusts body user_id.
- `POST /api/events/:id/numeric-sell` — same.
- All forward to `http://prediction-engine:3001` with `predictionEngineHeaders`.

**Steps:** red jest (401 unauthenticated, tier gate, happy-path pass-through with engine stubbed or against live engine following the existing proxy test pattern) → implement → green → restart backend → commit.

### Task 9 (B5): DistributionMarketCard frontend

**Files:**
- Create: `frontend-solid/src/components/predictions/DistributionMarketCard.jsx`
- Modify: `frontend-solid/src/components/predictions/MarketDetailView.jsx` (dispatch: numeric+configured → DistributionMarketCard; keep OutcomeMarketCard for multiple_choice), `frontend-solid/src/components/predictions/MyPositions.jsx` (same dispatch for numeric rows)
- Modify: `frontend-solid/src/services/api.js` (numericQuote/numericTrade/numericSell)
- Modify: `frontend-solid/src/styles.css`

**Interfaces:**
- Data in: event row + `GET /events/:id/shares` pattern for own position (reuse whatever OutcomeMarketCard uses to load outcomes+state; bins arrive as outcomes with bounds).
- Editor state: `low`, `center`, `high` (init from current market quartiles), presets narrow/medium/wide (scale spread ×0.5/1/2), budget input (RP, converted ×1e6 to ledger).
- Curve fit → `u`: split-normal, σ_left=(center−low)/1.2816, σ_right=(high−center)/1.2816 (P10/P90 z-score), CDF integrated over bin edges via erf; floor 1e-9, renormalize. Include this formula as a tested util (`distributionMath.js` with a tiny jest-less assert page OR unit-tested via E2E-checked values — put pure math in `frontend-solid/src/utils/distributionMath.js`).
- SVG (hand-rolled, viewBox 640×200): market mass as filled steps, user target line, after-trade preview (from live debounced quote) as dashed line; y = probability mass per bin.
- Trade flow: debounce 400ms → quote → show "cost X RP, moves market this far (α)" → Buy button → trade → refetch → success/failure copy mirrors OutcomeMarketCard patterns (incl. verification-notice handling and logged-out state).
- Position block: cost basis (sum trades), current sale value (quote of full sell), Sell-all button.
- Copy: "80% chance between {low} and {high}", "most likely around {center}"; button "Trade"; label "Trade size (RP)".

**Steps:**
- [ ] Red: E2E additions (next task's spec file, or extend market-detail.spec.js): numeric fixture event (seed 50 bins + config via SQL in beforeAll) renders DistributionMarketCard (curve svg, three handles), logged-in trade with 50 RP budget succeeds, market curve changes, position block appears, sell-all restores. Watch fail.
- [ ] Implement component + math util; green locally; commit.

### Task 10 (B6): E2E wrap, backfill, deploy

**Steps:**
- [ ] Full E2E: market-detail + numeric spec + MC spec + regression (predictions-tabs, keyboard, my-positions) — all green ×2.
- [ ] Frontend build gate (node:24 disposable, repo mount).
- [ ] Deploy order: backend restart (migrations already ran in Task 4 — confirm), engine rebuild (already), frontend restart LAST; verify intellacc.de bundle marker + a real numeric market trades end-to-end in prod (small stake, then sell — use user1, tier 2, then restore tier).
- [ ] Run `/metaculus/sync`; report how many of the 171 numeric events got bins (bounded linear only) and how many remain hidden.
- [ ] Push, `gh run watch` to green. Update memory + ledger.
