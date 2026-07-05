# Multi-Outcome Trading UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users trade (buy AND sell), create, and admin-resolve multiple_choice and numeric-bucket prediction markets end-to-end — engine, backend, and Solid frontend.

**Architecture:** The engine gains an outcome-level sell endpoint (mirroring the existing binary sell transaction using the N-outcome LMSR core); the backend proxies it, unions multi-outcome positions into the portfolio endpoint, and threads `event_type`/outcomes through the community question-submission pipeline. The frontend gets a new `OutcomeMarketCard` (select-then-trade UX) dispatched by `event_type`, plus outcome-aware admin resolution and creation forms. The binary money path (`MarketEventCard`, `/update`, `/sell`) is never behaviorally changed.

**Tech Stack:** Rust (Axum, SQLx, LMSR), Express.js + PostgreSQL, SolidJS, Jest + supertest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-05-multi-outcome-trading-ui-design.md`

## Global Constraints

- **Worktree execution:** All work happens in `/var/opt/docker/intellacc.com/.claude/worktrees/pane2-work` on branch `multi-outcome-trading-ui`. The running Docker containers mount the MAIN checkout, not this worktree — never test worktree code with `docker exec intellacc_backend npm test`. Use the disposable-container commands below.
- **Backend tests** (runs worktree code against the shared dev DB on the `intellacc-network`; tests create and clean up their own rows):
  ```bash
  docker run --rm --network intellacc-network \
    -v /var/opt/docker/intellacc.com/.claude/worktrees/pane2-work/backend:/app -w /app \
    -v pane2_backend_node_modules:/app/node_modules \
    -e DATABASE_URL='postgres://intellacc_user:supersecretpassword@db:5432/intellaccdb' \
    node:24 sh -c "npm ci --no-audit --no-fund >/dev/null 2>&1 && NODE_ENV=test ALLOW_REGISTRATION=true npx jest <TESTFILE> --runInBand"
  ```
- **Engine tests** (pure-math tests, no DB needed at test time):
  ```bash
  docker run --rm \
    -v /var/opt/docker/intellacc.com/.claude/worktrees/pane2-work/prediction-engine:/app -w /app \
    -v pane2_cargo_registry:/usr/local/cargo/registry \
    -v pane2_cargo_target:/app/target \
    rust:latest cargo test <FILTER>
  ```
  Full compile check: same command with `cargo build --release` (also proves the SQLx/Axum code compiles).
- **Frontend build check** (no unit test rig exists; the gate is a clean Vite build):
  ```bash
  docker run --rm \
    -v /var/opt/docker/intellacc.com/.claude/worktrees/pane2-work:/repo -w /repo/frontend-solid \
    -v pane2_frontend_node_modules:/repo/frontend-solid/node_modules \
    node:24 sh -c "npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build"
  ```
- **Ledger units:** RP amounts are stored as integers scaled by `LEDGER_SCALE = 1_000_000`. All proportional stake math must be integer ledger math (copy the binary-sell pattern), never f64 division of ledger values.
- **Money-path safety:** `MarketEventCard.jsx`, `POST /events/:id/update`, `POST /events/:id/sell`, and the binary branches of the engine must not change behavior. Extractions from `MarketEventCard.jsx` are move-only.
- **Commits:** commit after every task (message given per task). End commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Event types in scope:** `multiple_choice` and `numeric`. `discrete`/`date` stay untouched.
- Numeric buckets always have finite `lower_bound < upper_bound`; the backend rejects anything else. No open-ended buckets anywhere.

---

### Task 1: Engine — pure outcome-sell math in `lmsr_multi_core.rs`

**Files:**
- Modify: `prediction-engine/src/lmsr_multi_core.rs`

**Interfaces:**
- Consumes: existing `cost(q, b)`, `MultiMarket` (this file).
- Produces: `pub fn sell_payout(outcome_idx: usize, q: &[f64], b: f64, amount: f64) -> Result<f64>` and `MultiMarket::sell_outcome(&mut self, outcome_idx: usize, amount: f64) -> Result<f64>` (returns payout; mutates `self.q[outcome_idx] -= amount`). Task 2 calls `MultiMarket::sell_outcome`.

- [ ] **Step 1: Write the failing tests**

Append to the bottom of `prediction-engine/src/lmsr_multi_core.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_then_sell_round_trip_returns_stake_no_free_money() {
        let mut market = MultiMarket::new(vec![0.0; 4], 5000.0).unwrap();
        let stake = 100.0;
        let (shares, cost_paid) = market.buy_outcome(2, stake).unwrap();
        assert!(shares > 0.0);
        let payout = market.sell_outcome(2, shares).unwrap();
        // LMSR is path-independent: selling the exact shares bought must return
        // (within bisection tolerance) exactly the stake — and never more.
        assert!(
            (payout - cost_paid).abs() < 1e-6,
            "round trip mismatch: paid {cost_paid}, got back {payout}"
        );
    }

    #[test]
    fn partial_sell_moves_prob_down_and_probs_renormalize() {
        let mut market = MultiMarket::new(vec![0.0; 3], 5000.0).unwrap();
        let (shares, _) = market.buy_outcome(0, 500.0).unwrap();
        let prob_before = market.probs()[0];
        let payout = market.sell_outcome(0, shares / 2.0).unwrap();
        assert!(payout > 0.0);
        let probs = market.probs();
        assert!(probs[0] < prob_before, "selling must lower the sold outcome's prob");
        let sum: f64 = probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9, "probs must renormalize, got {sum}");
    }

    #[test]
    fn sell_payout_rejects_invalid_inputs() {
        let q = vec![0.0, 0.0];
        assert!(sell_payout(5, &q, 5000.0, 1.0).is_err(), "bad index");
        assert!(sell_payout(0, &q, 5000.0, 0.0).is_err(), "zero amount");
        assert!(sell_payout(0, &q, 5000.0, -1.0).is_err(), "negative amount");
        assert!(sell_payout(0, &q, 5000.0, f64::NAN).is_err(), "NaN amount");
        assert!(sell_payout(0, &q, 0.0, 1.0).is_err(), "bad liquidity");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (Global Constraints engine command, `FILTER=lmsr_multi_core`):
Expected: compile error — `sell_outcome`/`sell_payout` not found.

- [ ] **Step 3: Write the implementation**

Add to `prediction-engine/src/lmsr_multi_core.rs`, inside `impl MultiMarket` (after `buy_outcome`):

```rust
    pub fn sell_outcome(&mut self, outcome_idx: usize, amount: f64) -> Result<f64> {
        let payout = sell_payout(outcome_idx, &self.q, self.b, amount)?;
        self.q[outcome_idx] -= amount;
        Ok(payout)
    }
```

And as a free function (after `delta_q_for_stake`):

```rust
/// Payout for selling `amount` shares of one outcome: C(q) - C(q - amount*e_idx).
/// Holdings checks live at the API layer; this is pure market math.
pub fn sell_payout(outcome_idx: usize, q: &[f64], b: f64, amount: f64) -> Result<f64> {
    if outcome_idx >= q.len() {
        return Err(anyhow!("invalid outcome index"));
    }
    if !amount.is_finite() || amount <= 0.0 {
        return Err(anyhow!("amount must be positive and finite"));
    }
    if q.iter().any(|v| !v.is_finite()) {
        return Err(anyhow!("all q values must be finite"));
    }
    if !b.is_finite() || b <= 0.0 {
        return Err(anyhow!("b must be positive and finite"));
    }

    let before = cost(q, b);
    let mut q_after = q.to_vec();
    q_after[outcome_idx] -= amount;
    let payout = before - cost(&q_after, b);
    if !payout.is_finite() || payout < 0.0 {
        return Err(anyhow!("failed to compute sell payout"));
    }
    Ok(payout)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run the engine test command with `FILTER=lmsr_multi_core`.
Expected: `test result: ok.` with the 3 new tests (plus any pre-existing) passing.

- [ ] **Step 5: Commit**

```bash
git add prediction-engine/src/lmsr_multi_core.rs
git commit -m "feat(engine): pure N-outcome LMSR sell math

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Engine — `POST /events/:id/sell-outcome` endpoint

**Files:**
- Modify: `prediction-engine/src/lmsr_api.rs` (new struct + transaction, near the binary `sell_shares` at line ~724)
- Modify: `prediction-engine/src/main.rs` (new handler + route, near `sell_shares_endpoint` at line ~1081 and the router block at line ~199)

**Interfaces:**
- Consumes: `MultiMarket::sell_outcome` (Task 1), existing `fetch_outcome_state_rows`, `DbAdapter::update_user_balance_ledger`, `with_optimistic_tx!`, `ERR_MARKET_RESOLVED`/`ERR_MARKET_CLOSED`, `to_ledger_units`.
- Produces: HTTP `POST /events/:id/sell-outcome` with request `{ user_id: i32, outcome_id: i64, amount: f64 }` and response `OutcomeSellResult { event_id, outcome_id, payout, new_prob, current_cost_c, market_prob, outcomes: [MarketOutcomeView] }`. Task 3's proxy forwards to this.

- [ ] **Step 1: Add `OutcomeSellResult` struct**

In `prediction-engine/src/lmsr_api.rs`, directly after the `OutcomeUpdateResult` struct (line ~160):

```rust
#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../shared/types/OutcomeSellResult.ts")]
pub struct OutcomeSellResult {
    pub event_id: i32,
    pub outcome_id: i64,
    pub payout: f64,
    pub new_prob: f64,
    pub current_cost_c: f64,
    pub market_prob: f64,
    pub outcomes: Vec<MarketOutcomeView>,
}
```

- [ ] **Step 2: Add the sell transaction**

In `prediction-engine/src/lmsr_api.rs`, directly after `sell_shares_transaction` (line ~931), add. This mirrors the buy path (`update_market_outcome_transaction`) for state management and the binary sell path for the integer-ledger stake unwind:

```rust
// Sell shares of one outcome back into an N-outcome market.
pub async fn sell_outcome_shares(
    pool: &PgPool,
    config: &Config,
    user_id: i32,
    event_id: i32,
    outcome_id: i64,
    amount: f64,
) -> Result<OutcomeSellResult> {
    if outcome_id <= 0 {
        return Err(anyhow!("outcome_id must be positive"));
    }
    if !amount.is_finite() || amount <= 0.0 {
        return Err(anyhow!("Amount must be positive"));
    }

    with_optimistic_tx!(pool, tx, {
        sell_outcome_shares_transaction(&mut tx, config, user_id, event_id, outcome_id, amount)
            .await
    })
}

async fn sell_outcome_shares_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    config: &Config,
    user_id: i32,
    event_id: i32,
    outcome_id: i64,
    amount: f64,
) -> Result<OutcomeSellResult> {
    // Lock the event row FIRST (consistent lock order with the buy path).
    let event_row = sqlx::query(
        r#"
        SELECT
            event_type,
            liquidity_b,
            q_yes,
            q_no,
            outcome,
            COALESCE(closing_date <= NOW(), false) AS is_closed
        FROM events
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(event_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(|_| anyhow!("Event not found or market not initialized"))?;

    let event_type: String = event_row.get("event_type");
    let outcome: Option<String> = event_row.get("outcome");
    let is_closed: bool = event_row.get("is_closed");
    if outcome.is_some() {
        return Err(anyhow!(ERR_MARKET_RESOLVED));
    }
    if is_closed {
        return Err(anyhow!(ERR_MARKET_CLOSED));
    }
    if event_type == "binary" {
        return Err(anyhow!("Use legacy binary sell endpoint for binary markets"));
    }

    // Hold period: outcome buys journal into market_outcome_updates.
    if config.market.enable_hold_period {
        let active_holds: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM market_outcome_updates
             WHERE user_id = $1 AND event_id = $2 AND hold_until > NOW()",
        )
        .bind(user_id)
        .bind(event_id)
        .fetch_one(tx.as_mut())
        .await?;
        if active_holds > 0 {
            return Err(anyhow!("Hold period not expired for recent purchases"));
        }
    }

    // Lock the user's position row SECOND (consistent lock order).
    let share_row = sqlx::query(
        "SELECT shares, staked_ledger
         FROM user_outcome_shares
         WHERE user_id = $1 AND event_id = $2 AND outcome_id = $3
         FOR UPDATE",
    )
    .bind(user_id)
    .bind(event_id)
    .bind(outcome_id)
    .fetch_optional(tx.as_mut())
    .await?;

    let (held_shares, staked_ledger): (f64, i64) = match share_row {
        Some(r) => (r.get("shares"), r.get("staked_ledger")),
        None => (0.0, 0),
    };
    if held_shares < amount {
        return Err(anyhow!("Insufficient shares in selected outcome"));
    }

    let liquidity_b: f64 = event_row.get("liquidity_b");
    let mut outcomes = fetch_outcome_state_rows(tx, event_id).await?;
    if outcomes.len() < 2 {
        return Err(anyhow!(
            "This market has no configured outcomes yet. Configure outcomes first."
        ));
    }
    let selected_idx = outcomes
        .iter()
        .position(|o| o.outcome_id == outcome_id)
        .ok_or_else(|| anyhow!("Selected outcome is not active for this market"))?;

    let q: Vec<f64> = outcomes.iter().map(|o| o.q_value).collect();
    let mut market = MultiMarket::new(q, liquidity_b)?;
    let payout = market.sell_outcome(selected_idx, amount)?;
    let new_probs = market.probs();
    let new_prob = new_probs[selected_idx];
    let new_cumulative_cost = market.cost();

    // Proportional stake unwind in pure integer ledger math (binary-sell pattern).
    let amount_ledger =
        to_ledger_units(amount).map_err(|e| anyhow!("Invalid sell amount: {}", e))?;
    let shares_ledger =
        to_ledger_units(held_shares).map_err(|e| anyhow!("Invalid shares amount: {}", e))?;
    if shares_ledger == 0 {
        return Err(anyhow!("Cannot calculate proportional stake for zero shares"));
    }
    let numer = (staked_ledger as i128)
        .checked_mul(amount_ledger)
        .ok_or_else(|| anyhow!("Arithmetic overflow in proportional stake calculation"))?;
    let stake_to_unwind = ((numer + (shares_ledger / 2)) / shares_ledger)
        .max(0)
        .min(staked_ledger as i128);
    let stake_to_unwind_ledger = i64::try_from(stake_to_unwind)
        .map_err(|_| anyhow!("stake_to_unwind_ledger out of i64 range"))?;

    let payout_ledger =
        to_ledger_units(payout).map_err(|e| anyhow!("Invalid payout: {}", e))?;
    let payout_ledger_i64 =
        i64::try_from(payout_ledger).map_err(|_| anyhow!("payout_ledger out of i64 range"))?;

    // Persist new outcome states (same upsert as the buy path).
    for (idx, outcome_row) in outcomes.iter_mut().enumerate() {
        outcome_row.q_value = market.q[idx];
        outcome_row.prob = new_probs[idx];
        sqlx::query(
            r#"
            INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (event_id, outcome_id)
            DO UPDATE SET
                q_value = EXCLUDED.q_value,
                prob = EXCLUDED.prob,
                updated_at = NOW()
            "#,
        )
        .bind(event_id)
        .bind(outcome_row.outcome_id)
        .bind(outcome_row.q_value)
        .bind(outcome_row.prob)
        .execute(tx.as_mut())
        .await?;
    }

    // Mirror the buy path's events-row bookkeeping.
    let market_prob = outcomes
        .iter()
        .find(|o| o.outcome_key.eq_ignore_ascii_case("yes"))
        .map(|o| o.prob)
        .unwrap_or_else(|| outcomes.iter().fold(0.0, |acc, row| acc.max(row.prob)));
    let q_yes = outcomes
        .iter()
        .find(|o| o.outcome_key.eq_ignore_ascii_case("yes"))
        .map(|o| o.q_value)
        .unwrap_or_else(|| event_row.get("q_yes"));
    let q_no = outcomes
        .iter()
        .find(|o| o.outcome_key.eq_ignore_ascii_case("no"))
        .map(|o| o.q_value)
        .unwrap_or_else(|| event_row.get("q_no"));

    sqlx::query(
        r#"
        UPDATE events
        SET market_prob = $1,
            cumulative_stake = $2,
            q_yes = $3,
            q_no = $4
        WHERE id = $5
        "#,
    )
    .bind(market_prob)
    .bind(new_cumulative_cost)
    .bind(q_yes)
    .bind(q_no)
    .bind(event_id)
    .execute(tx.as_mut())
    .await?;

    // Credit payout, unwind staked total (balance += payout, staked -= unwind).
    let rows = DbAdapter::update_user_balance_ledger(
        tx,
        user_id,
        payout_ledger_i64,
        -stake_to_unwind_ledger,
    )
    .await?;
    if rows == 0 {
        return Err(anyhow!("Failed to update user balance"));
    }

    sqlx::query(
        "UPDATE user_outcome_shares
         SET shares = shares - $4,
             staked_ledger = staked_ledger - $5,
             version = version + 1,
             updated_at = NOW()
         WHERE user_id = $1 AND event_id = $2 AND outcome_id = $3",
    )
    .bind(user_id)
    .bind(event_id)
    .bind(outcome_id)
    .bind(amount)
    .bind(stake_to_unwind_ledger)
    .execute(tx.as_mut())
    .await?;

    Ok(OutcomeSellResult {
        event_id,
        outcome_id,
        payout,
        new_prob,
        current_cost_c: new_cumulative_cost,
        market_prob,
        outcomes: outcomes
            .into_iter()
            .map(|row| MarketOutcomeView {
                outcome_id: row.outcome_id,
                outcome_key: row.outcome_key,
                label: row.label,
                prob: row.prob,
                q_value: row.q_value,
                lower_bound: row.lower_bound,
                upper_bound: row.upper_bound,
            })
            .collect(),
    })
}
```

Note: no journal row is written — binary sells don't journal into `market_updates` either; this matches that behavior (spec §1).

- [ ] **Step 3: Add the Axum handler and route**

In `prediction-engine/src/main.rs`, directly after `update_market_outcome_endpoint` (ends line ~1014):

```rust
// Sell shares of an explicit outcome (multiple choice / numeric buckets)
async fn sell_outcome_shares_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    let user_id = payload
        .get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid user_id: must be a positive integer")
        })? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    let outcome_id = payload
        .get("outcome_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid outcome_id"))?;
    if outcome_id <= 0 {
        return Err(bad_request_error("Invalid outcome_id: must be positive"));
    }

    let amount = payload
        .get("amount")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| bad_request_error("Missing or invalid amount: must be a finite number"))?;
    if !amount.is_finite() || amount <= 0.0 {
        return Err(bad_request_error("Invalid amount: must be positive and finite"));
    }
    if amount > 10_000_000.0 {
        return Err(bad_request_error(
            "Invalid amount: exceeds maximum allowed (10,000,000 shares)",
        ));
    }
    if amount < 0.000001 {
        return Err(bad_request_error(
            "Invalid amount: below minimum allowed (0.000001 shares)",
        ));
    }

    match lmsr_api::sell_outcome_shares(
        &app_state.db,
        &app_state.config,
        user_id,
        event_id,
        outcome_id,
        amount,
    )
    .await
    {
        Ok(result) => {
            invalidate_and_broadcast(
                &app_state,
                "shares_sold",
                json!({
                    "event_id": event_id,
                    "user_id": user_id,
                    "outcome_id": outcome_id,
                    "amount": amount,
                    "payout": result.payout,
                    "new_prob": result.market_prob,
                    "cumulative_stake": result.current_cost_c
                }),
            );
            Ok(Json(json!(result)))
        }
        Err(e) => {
            let msg = e.to_string();
            let msg_lower = msg.to_lowercase();
            if msg_lower.contains("market resolved") {
                return Err(bad_request_error("Market resolved"));
            }
            if msg_lower.contains("market closed") {
                return Err(bad_request_error("Market closed"));
            }
            if msg_lower.contains("insufficient shares")
                || msg_lower.contains("hold period")
                || msg_lower.contains("no configured outcomes")
                || msg_lower.contains("selected outcome")
                || msg_lower.contains("binary markets")
            {
                return Err(bad_request_error(&msg));
            }
            Err(internal_error(&format!("Outcome sell error: {}", msg)))
        }
    }
}
```

In the router block (line ~199), directly after `.route("/events/:id/sell", post(sell_shares_endpoint))`:

```rust
        .route(
            "/events/:id/sell-outcome",
            post(sell_outcome_shares_endpoint),
        )
```

- [ ] **Step 4: Compile + run all engine tests**

Run the engine test command with no filter (`cargo test`), then `cargo build --release`.
Expected: everything compiles; all existing tests plus Task 1's tests pass. (This task's DB logic is integration-covered by the E2E task; there is no engine DB test rig.)

- [ ] **Step 5: Commit**

```bash
git add prediction-engine/src/lmsr_api.rs prediction-engine/src/main.rs
git commit -m "feat(engine): POST /events/:id/sell-outcome for N-outcome markets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend — extract shared event-outcome helpers (move-only)

**Files:**
- Create: `backend/src/utils/eventOutcomes.js`
- Modify: `backend/src/controllers/predictionsController.js:28-176` (delete the moved definitions, import instead)

**Interfaces:**
- Produces: `module.exports = { ALLOWED_EVENT_TYPES, normalizeEventType, ensureUniqueOutcomeKeys, normalizeOutcomeRows, validateNumericBuckets, seedEventOutcomes }` — exact same signatures/bodies as today in `predictionsController.js` (`normalizeOutcomeRows(eventType, outcomes, numericBuckets)`, `validateNumericBuckets(rows)`, `seedEventOutcomes(client, eventId, eventType, outcomeRows)`). Task 6 imports these in `marketQuestionController.js`.

- [ ] **Step 1: Create the module**

Create `backend/src/utils/eventOutcomes.js` containing, verbatim (move, don't rewrite), the following blocks from `backend/src/controllers/predictionsController.js`: `ALLOWED_EVENT_TYPES` (line 28), `normalizeEventType` (30-33), `ensureUniqueOutcomeKeys` (35-47), `normalizeOutcomeRows` (49-103), `validateNumericBuckets` (105-113), `seedEventOutcomes` (115-176). Header + exports:

```js
// Shared helpers for multi-outcome (multiple_choice / numeric bucket) events.
// Used by direct event creation and the market-question submission pipeline.

/* ...moved code exactly as-is... */

module.exports = {
  ALLOWED_EVENT_TYPES,
  normalizeEventType,
  ensureUniqueOutcomeKeys,
  normalizeOutcomeRows,
  validateNumericBuckets,
  seedEventOutcomes
};
```

- [ ] **Step 2: Rewire predictionsController**

In `backend/src/controllers/predictionsController.js`, delete the moved definitions and add below the existing requires:

```js
const {
  normalizeEventType,
  normalizeOutcomeRows,
  validateNumericBuckets,
  seedEventOutcomes
} = require('../utils/eventOutcomes');
```

(`normalizeMarketOutcome` at lines 9-26 stays in the controller — it is resolution-specific.)

- [ ] **Step 3: Run the touching backend suites**

Run the backend test command with `TESTFILE="test/event_resolution.test.js test/market_lifecycle.test.js test/market_question_validation.test.js"`.
Expected: PASS (pure refactor, no behavior change).

- [ ] **Step 4: Commit**

```bash
git add backend/src/utils/eventOutcomes.js backend/src/controllers/predictionsController.js
git commit -m "refactor(backend): extract event-outcome helpers to utils/eventOutcomes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Backend — `POST /events/:eventId/sell-outcome` proxy (+ first `update-outcome` proxy coverage)

**Files:**
- Modify: `backend/src/routes/api.js` (new route after the `update-outcome` proxy, line ~743)
- Test: `backend/test/outcome_trading_proxy.test.js` (new)

**Interfaces:**
- Consumes: engine `POST /events/:id/sell-outcome` (Task 2; mocked in tests), existing `ensureEventIsActive`, `predictionEngineHeaders`, middleware `authenticateJWT`, `requirePhoneVerified`, `requireScope('market:trade')`.
- Produces: `POST /api/events/:eventId/sell-outcome` accepting `{ outcome_id, amount }` (user from JWT), passing engine JSON through, emitting socket `marketUpdate` with `action: 'sell-outcome'`. Task 7's `sellOutcome` calls this.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/outcome_trading_proxy.test.js`:

```js
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const makeUser = async (label, verificationTier = 2) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  const password = 'testpass123';
  const passwordHash = await bcrypt.hash(password, 10);
  const userResult = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, verification_tier)
     VALUES ($1, $2, $3, NOW(), $4) RETURNING id`,
    [email, unique, passwordHash, verificationTier]
  );
  const loginRes = await request(app).post('/api/login').send({ email, password });
  expect(loginRes.statusCode).toBe(200);
  return { id: userResult.rows[0].id, token: loginRes.body.token };
};

const createMultiEvent = async ({ outcome = null } = {}) => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type, outcome)
     VALUES ($1, $2, NOW() + INTERVAL '7 days', 'multiple_choice', $3)
     RETURNING id`,
    [`Outcome proxy test ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'test', outcome]
  );
  const eventId = result.rows[0].id;
  const outcomeRes = await db.query(
    `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
     VALUES ($1, 'choice_1', 'Option A', 0), ($1, 'choice_2', 'Option B', 1)
     RETURNING id`,
    [eventId]
  );
  return { eventId, outcomeIds: outcomeRes.rows.map((r) => r.id) };
};

describe('Outcome trading proxy routes', () => {
  const cleanup = { events: new Set(), users: new Set() };
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payout: 12.5,
        market_prob: 0.4,
        current_cost_c: 3500,
        outcomes: []
      })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(async () => {
    for (const eventId of cleanup.events) {
      await db.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
    for (const userId of cleanup.users) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('sell-outcome forwards user, outcome and amount to the engine', async () => {
    const user = await makeUser('sellout_ok');
    const { eventId, outcomeIds } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ outcome_id: outcomeIds[0], amount: 3.5 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('payout', 12.5);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${eventId}/sell-outcome`);
    expect(JSON.parse(calledOptions.body)).toEqual({
      user_id: user.id,
      outcome_id: outcomeIds[0],
      amount: 3.5
    });
  });

  test('sell-outcome rejects bad payloads without calling the engine', async () => {
    const user = await makeUser('sellout_bad');
    const { eventId } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    for (const body of [
      { outcome_id: 0, amount: 1 },
      { outcome_id: 'abc', amount: 1 },
      { outcome_id: 1, amount: 0 },
      { outcome_id: 1, amount: -2 },
      { outcome_id: 1 }
    ]) {
      const res = await request(app)
        .post(`/api/events/${eventId}/sell-outcome`)
        .set('Authorization', `Bearer ${user.token}`)
        .send(body);
      expect(res.statusCode).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sell-outcome requires auth and phone verification', async () => {
    const { eventId } = await createMultiEvent();
    cleanup.events.add(eventId);

    const anon = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .send({ outcome_id: 1, amount: 1 });
    expect(anon.statusCode).toBe(401);

    const tier1 = await makeUser('sellout_tier1', 1);
    cleanup.users.add(tier1.id);
    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${tier1.token}`)
      .send({ outcome_id: 1, amount: 1 });
    expect(res.statusCode).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sell-outcome blocks resolved events before reaching the engine', async () => {
    const user = await makeUser('sellout_resolved');
    const { eventId, outcomeIds } = await createMultiEvent({ outcome: 'resolved_outcome_1' });
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    const res = await request(app)
      .post(`/api/events/${eventId}/sell-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ outcome_id: outcomeIds[0], amount: 1 });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('update-outcome forwards stake and outcome_id (first coverage)', async () => {
    const user = await makeUser('updout_ok');
    const { eventId, outcomeIds } = await createMultiEvent();
    cleanup.users.add(user.id);
    cleanup.events.add(eventId);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ market_prob: 0.6, outcomes: [], shares_acquired: 5 })
    });

    const res = await request(app)
      .post(`/api/events/${eventId}/update-outcome`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ stake: 10, outcome_id: outcomeIds[1] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('shares_acquired', 5);
    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${eventId}/update-outcome`);
    expect(JSON.parse(calledOptions.body)).toEqual({
      user_id: user.id,
      stake: 10,
      outcome_id: outcomeIds[1]
    });
  });
});
```

- [ ] **Step 2: Run tests to verify the sell-outcome ones fail**

Run backend test command, `TESTFILE=test/outcome_trading_proxy.test.js`.
Expected: sell-outcome tests FAIL with 404 (route doesn't exist); the update-outcome test PASSES (route exists).

- [ ] **Step 3: Add the route**

In `backend/src/routes/api.js`, directly after the `update-outcome` route (before `module.exports`, line ~745):

```js
router.post("/events/:eventId/sell-outcome", authenticateJWT, requirePhoneVerified, requireScope('market:trade'), async (req, res) => {
    const { eventId } = req.params;
    const eventIdNumber = Number(eventId);
    const outcomeIdNumber = Number(req.body?.outcome_id);
    const amount = Number(req.body?.amount);

    if (!Number.isInteger(eventIdNumber) || eventIdNumber <= 0) {
        return res.status(400).json({ message: 'Invalid event id' });
    }
    if (!Number.isInteger(outcomeIdNumber) || outcomeIdNumber <= 0) {
        return res.status(400).json({ message: 'Invalid outcome id' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ message: 'Invalid amount' });
    }

    try {
        const lifecycleValidation = await ensureEventIsActive(eventIdNumber);
        if (lifecycleValidation.status !== 200) {
            return res.status(lifecycleValidation.status).json(lifecycleValidation.payload);
        }
    } catch (error) {
        console.error('Error loading event lifecycle state:', error);
        return res.status(500).json({ error: 'Failed to validate event state' });
    }

    try {
        const userId = req.user.id;
        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/sell-outcome`, {
            method: 'POST',
            headers: predictionEngineHeaders,
            body: JSON.stringify({ user_id: userId, outcome_id: outcomeIdNumber, amount })
        });
        const data = await response.json();

        if (response.ok) {
            const io = req.app.get('io');
            if (io && data.market_prob !== undefined) {
                io.to('predictions').emit('marketUpdate', {
                    eventId: eventIdNumber,
                    market_prob: parseFloat(data.market_prob),
                    cumulative_stake: data.current_cost_c,
                    action: 'sell-outcome',
                    user_id: userId,
                    outcome_id: outcomeIdNumber,
                    amount,
                    timestamp: new Date().toISOString()
                });
            }
            return res.json(data);
        }
        return res.status(response.status).json(data);
    } catch (error) {
        console.error('Sell outcome proxy error:', error);
        return res.status(500).json({ error: 'Failed to sell outcome shares' });
    }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Same command. Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/api.js backend/test/outcome_trading_proxy.test.js
git commit -m "feat(backend): sell-outcome proxy route + outcome trading proxy tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Backend — union multi-outcome holdings into `getUserPositions`

**Files:**
- Modify: `backend/src/controllers/userController.js:1276-1291`
- Test: `backend/test/user_positions_outcomes.test.js` (new)

**Interfaces:**
- Produces: `GET /api/users/:id/positions` rows gain `event_type`. Binary rows keep today's exact shape plus `outcome_id: null`. New multi-outcome rows: `{ event_id, yes_shares: 0, no_shares: 0, outcome_id, outcome_label, outcome_shares, outcome_staked_rp, event_title, category, closing_date, market_prob, cumulative_stake, event_type }`. Task 9's card filters rows by `event_id` + non-null `outcome_id`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/user_positions_outcomes.test.js`:

```js
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

describe('GET /users/:id/positions with multi-outcome holdings', () => {
  const cleanup = { events: new Set(), users: new Set() };

  const makeUser = async (label) => {
    const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const email = `${unique}@example.com`;
    const password = 'testpass123';
    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await db.query(
      `INSERT INTO users (email, username, password_hash, created_at, verification_tier)
       VALUES ($1, $2, $3, NOW(), 2) RETURNING id`,
      [email, unique, passwordHash]
    );
    const loginRes = await request(app).post('/api/login').send({ email, password });
    expect(loginRes.statusCode).toBe(200);
    return { id: userResult.rows[0].id, token: loginRes.body.token };
  };

  afterAll(async () => {
    for (const eventId of cleanup.events) {
      await db.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
    for (const userId of cleanup.users) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('returns binary and outcome positions side by side', async () => {
    const user = await makeUser('positions_union');
    cleanup.users.add(user.id);

    // Binary position
    const binaryEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type)
       VALUES ('Binary pos test', 'x', NOW() + INTERVAL '7 days', 'binary') RETURNING id`
    );
    const binaryEventId = binaryEvent.rows[0].id;
    cleanup.events.add(binaryEventId);
    await db.query(
      `INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares)
       VALUES ($1, $2, 4.5, 0)`,
      [user.id, binaryEventId]
    );

    // Multi-outcome position
    const mcEvent = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type)
       VALUES ('MC pos test', 'x', NOW() + INTERVAL '7 days', 'multiple_choice') RETURNING id`
    );
    const mcEventId = mcEvent.rows[0].id;
    cleanup.events.add(mcEventId);
    const outcomeRes = await db.query(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES ($1, 'choice_1', 'Alpha', 0) RETURNING id`,
      [mcEventId]
    );
    const outcomeId = outcomeRes.rows[0].id;
    await db.query(
      `INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger, version)
       VALUES ($1, $2, $3, 7.25, 3000000, 1)`,
      [user.id, mcEventId, outcomeId]
    );

    const res = await request(app)
      .get(`/api/users/${user.id}/positions`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    const rows = res.body;

    const binaryRow = rows.find((r) => Number(r.event_id) === binaryEventId);
    expect(binaryRow).toBeDefined();
    expect(Number(binaryRow.yes_shares)).toBeCloseTo(4.5);
    expect(binaryRow.outcome_id).toBeNull();

    const outcomeRow = rows.find((r) => Number(r.event_id) === mcEventId);
    expect(outcomeRow).toBeDefined();
    expect(Number(outcomeRow.outcome_id)).toBe(outcomeId);
    expect(outcomeRow.outcome_label).toBe('Alpha');
    expect(Number(outcomeRow.outcome_shares)).toBeCloseTo(7.25);
    expect(Number(outcomeRow.outcome_staked_rp)).toBeCloseTo(3); // 3_000_000 ledger / 1e6
    expect(outcomeRow.event_type).toBe('multiple_choice');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Backend test command, `TESTFILE=test/user_positions_outcomes.test.js`.
Expected: FAIL — `outcomeRow` undefined (endpoint reads only `user_shares`).

- [ ] **Step 3: Replace the query in `getUserPositions`**

In `backend/src/controllers/userController.js`, replace the SQL (lines 1276-1291) with:

```js
    const result = await db.query(`
      SELECT
        us.event_id,
        us.yes_shares,
        us.no_shares,
        NULL::bigint AS outcome_id,
        NULL::text AS outcome_label,
        NULL::double precision AS outcome_shares,
        NULL::numeric AS outcome_staked_rp,
        e.title as event_title,
        'General'::text AS category,
        e.closing_date,
        e.market_prob,
        e.cumulative_stake,
        e.event_type,
        us.last_updated AS last_updated
      FROM user_shares us
      JOIN events e ON us.event_id = e.id
      WHERE us.user_id = $1
        AND (us.yes_shares > 0 OR us.no_shares > 0)

      UNION ALL

      SELECT
        uos.event_id,
        0::double precision AS yes_shares,
        0::double precision AS no_shares,
        uos.outcome_id,
        eo.label AS outcome_label,
        uos.shares AS outcome_shares,
        (uos.staked_ledger::numeric / 1000000.0) AS outcome_staked_rp,
        e.title as event_title,
        'General'::text AS category,
        e.closing_date,
        e.market_prob,
        e.cumulative_stake,
        e.event_type,
        uos.updated_at AS last_updated
      FROM user_outcome_shares uos
      JOIN events e ON uos.event_id = e.id
      JOIN event_outcomes eo ON eo.id = uos.outcome_id
      WHERE uos.user_id = $1
        AND uos.shares > 0

      ORDER BY last_updated DESC
    `, [authedUserId]);
```

- [ ] **Step 4: Run to verify it passes; check binary consumers**

Backend test command, `TESTFILE="test/user_positions_outcomes.test.js test/market_lifecycle.test.js"`.
Expected: PASS. (Binary rows keep all previous fields; the new columns are additive.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/userController.js backend/test/user_positions_outcomes.test.js
git commit -m "feat(backend): include multi-outcome holdings in user positions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Backend — multi-outcome creation through the question pipeline

**Files:**
- Create: `backend/migrations/20260705_add_market_question_multi_outcome.sql`
- Modify: `backend/src/controllers/marketQuestionController.js` (`createSubmission` line ~253, approval branch line ~520)
- Test: `backend/test/market_question_multi_outcome.test.js` (new)

**Interfaces:**
- Consumes: `normalizeEventType`, `normalizeOutcomeRows`, `validateNumericBuckets`, `seedEventOutcomes` from `backend/src/utils/eventOutcomes.js` (Task 3).
- Produces: `POST /api/market-questions` accepts optional `event_type` (`binary` default | `multiple_choice` | `numeric`), `outcomes` (array of strings/objects), `numeric_buckets` (array of `{lower_bound, upper_bound, label?}`). Normalized rows persist in `market_question_submissions.outcome_rows` (JSONB). On approval, the created event carries `event_type` and seeded `event_outcomes`/`event_outcome_states`. Task 12's form sends these fields.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/20260705_add_market_question_multi_outcome.sql`:

```sql
-- 2026-07-05: Multi-outcome market creation via the community question pipeline.
ALTER TABLE market_question_submissions
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) NOT NULL DEFAULT 'binary',
  ADD COLUMN IF NOT EXISTS outcome_rows JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'market_question_submissions_event_type_check'
  ) THEN
    ALTER TABLE market_question_submissions
      ADD CONSTRAINT market_question_submissions_event_type_check
      CHECK (event_type IN ('binary', 'multiple_choice', 'numeric'));
  END IF;
END $$;
```

- [ ] **Step 2: Apply the migration to the shared dev DB**

The backend container only auto-runs migrations from the MAIN checkout on start; apply the worktree migration manually (additive + idempotent, safe on the shared DB):

```bash
docker exec -i intellacc_db psql -U intellacc_user -d intellaccdb \
  < backend/migrations/20260705_add_market_question_multi_outcome.sql
```

Expected: `ALTER TABLE` / `DO` with no errors.

- [ ] **Step 3: Write the failing tests**

Create `backend/test/market_question_multi_outcome.test.js`. Reuse the helper style of `test/market_question_validation.test.js` (`createUser`, `login`, cleanup sets — copy those helpers verbatim from that file):

```js
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(60000);

const cleanup = { users: new Set(), events: new Set() };
const LEDGER_SCALE = 1_000_000n;

const createUser = async ({ email, username, password, rpBalanceLedger = 1_000n * LEDGER_SCALE }) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, updated_at, rp_balance_ledger)
     VALUES ($1, $2, $3, NOW(), NOW(), $4::bigint)
     RETURNING id`,
    [email, username, passwordHash, rpBalanceLedger.toString()]
  );
  const id = result.rows[0].id;
  cleanup.users.add(id);
  return id;
};

const login = async (email, password) => {
  const res = await request(app).post('/api/login').send({ email, password });
  expect(res.statusCode).toBe(200);
  return res.body.token;
};

describe('Market question pipeline: multi-outcome submissions', () => {
  afterAll(async () => {
    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }
    if (cleanup.users.size) {
      await db.query(
        'DELETE FROM market_question_submissions WHERE creator_user_id = ANY($1::int[])',
        [Array.from(cleanup.users)]
      );
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
    }
  });

  test('stores normalized multiple_choice outcomes on the submission', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createUser({ email: `mqmc_${ts}@example.com`, username: `mqmc_${ts}`, password });
    const token = await login(`mqmc_${ts}@example.com`, password);

    const res = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `MC question ${ts}`,
        details: 'Which option wins?',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'multiple_choice',
        outcomes: ['Alpha', 'Beta', 'Gamma']
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.submission.event_type).toBe('multiple_choice');
    const rows = res.body.submission.outcome_rows;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ key: 'choice_1', label: 'Alpha', sortOrder: 0 });
  });

  test('rejects multiple_choice submissions with fewer than two outcomes', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createUser({ email: `mqmc_short_${ts}@example.com`, username: `mqmc_short_${ts}`, password });
    const token = await login(`mqmc_short_${ts}@example.com`, password);

    const res = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `MC short ${ts}`,
        details: 'Not enough options',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'multiple_choice',
        outcomes: ['Only one']
      });

    expect(res.statusCode).toBe(400);
  });

  test('rejects overlapping numeric buckets', async () => {
    const ts = Date.now();
    const password = 'testpass123';
    await createUser({ email: `mqnum_${ts}@example.com`, username: `mqnum_${ts}`, password });
    const token = await login(`mqnum_${ts}@example.com`, password);

    const res = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: `Numeric overlap ${ts}`,
        details: 'Buckets overlap',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'numeric',
        numeric_buckets: [
          { lower_bound: 0, upper_bound: 10 },
          { lower_bound: 5, upper_bound: 15 }
        ]
      });

    expect(res.statusCode).toBe(400);
  });

  test('approved multiple_choice submission creates a seeded multi-outcome event', async () => {
    const ts = Date.now();
    const password = 'testpass123';

    await createUser({ email: `mqfin_creator_${ts}@example.com`, username: `mqfin_creator_${ts}`, password });
    const creatorToken = await login(`mqfin_creator_${ts}@example.com`, password);

    const createRes = await request(app)
      .post('/api/market-questions')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        title: `MC finalize ${ts}`,
        details: 'Which option wins?',
        closing_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_type: 'multiple_choice',
        outcomes: ['Alpha', 'Beta']
      });
    expect(createRes.statusCode).toBe(201);
    const submissionId = createRes.body.submission.id;
    const requiredValidators = createRes.body.submission.required_validators;

    for (let i = 0; i < requiredValidators; i += 1) {
      const email = `mqfin_val_${i}_${ts}@example.com`;
      await createUser({ email, username: `mqfin_val_${i}_${ts}`, password });
      const token = await login(email, password);
      const reviewRes = await request(app)
        .post(`/api/market-questions/${submissionId}/reviews`)
        .set('Authorization', `Bearer ${token}`)
        .send({ vote: 'approve' });
      expect([200, 201]).toContain(reviewRes.statusCode);
    }

    const subRes = await db.query(
      'SELECT status, approved_event_id FROM market_question_submissions WHERE id = $1',
      [submissionId]
    );
    expect(subRes.rows[0].status).toBe('approved');
    const eventId = subRes.rows[0].approved_event_id;
    expect(eventId).toBeTruthy();
    cleanup.events.add(eventId);

    const eventRes = await db.query('SELECT event_type FROM events WHERE id = $1', [eventId]);
    expect(eventRes.rows[0].event_type).toBe('multiple_choice');

    const outcomesRes = await db.query(
      'SELECT outcome_key, label FROM event_outcomes WHERE event_id = $1 ORDER BY sort_order',
      [eventId]
    );
    expect(outcomesRes.rows).toHaveLength(2);
    expect(outcomesRes.rows.map((r) => r.label)).toEqual(['Alpha', 'Beta']);

    const statesRes = await db.query(
      'SELECT prob FROM event_outcome_states WHERE event_id = $1',
      [eventId]
    );
    expect(statesRes.rows).toHaveLength(2);
    expect(Number(statesRes.rows[0].prob)).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Backend test command, `TESTFILE=test/market_question_multi_outcome.test.js`.
Expected: FAIL — `event_type` comes back `'binary'`/undefined, `outcome_rows` null, created event is binary with no outcomes.

- [ ] **Step 5: Implement controller changes**

In `backend/src/controllers/marketQuestionController.js`:

(a) Add to the requires at the top:

```js
const {
  normalizeEventType,
  normalizeOutcomeRows,
  validateNumericBuckets,
  seedEventOutcomes
} = require('../utils/eventOutcomes');
```

(b) In `createSubmission` (line ~253), extend destructuring and validation. Replace:

```js
  const { title, details, category = null, closing_date: closingDate } = req.body || {};
```

with:

```js
  const {
    title,
    details,
    category = null,
    closing_date: closingDate,
    event_type: rawEventType,
    outcomes,
    numeric_buckets: numericBuckets
  } = req.body || {};

  const eventType = normalizeEventType(rawEventType);
  if (!['binary', 'multiple_choice', 'numeric'].includes(eventType)) {
    return res.status(400).json({ message: 'event_type must be binary, multiple_choice or numeric' });
  }
  let outcomeRows = null;
  if (eventType !== 'binary') {
    outcomeRows = normalizeOutcomeRows(eventType, outcomes, numericBuckets);
    if (outcomeRows.length < 2) {
      return res.status(400).json({ message: `${eventType} questions require at least two outcomes/buckets` });
    }
    if (outcomeRows.length > 10) {
      return res.status(400).json({ message: 'At most 10 outcomes/buckets allowed' });
    }
    if (eventType === 'numeric' && !validateNumericBuckets(outcomeRows)) {
      return res.status(400).json({ message: 'numeric buckets overlap or are invalid' });
    }
  }
```

(c) Extend the INSERT (line ~300) to persist the new fields. Replace the statement with:

```js
    const insertRes = await client.query(
      `INSERT INTO market_question_submissions
        (creator_user_id, title, details, category, closing_date, creator_bond_ledger, required_validators, required_approvals, event_type, outcome_rows)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10::jsonb)
       RETURNING *`,
      [
        creatorUserId,
        String(title).trim(),
        String(details).trim(),
        category ? String(category).trim() : null,
        parsedClosingDate,
        bondLedger,
        REQUIRED_VALIDATORS,
        REQUIRED_APPROVALS,
        eventType,
        outcomeRows ? JSON.stringify(outcomeRows) : null
      ]
    );
```

(d) In the approval branch of `submitReview` (line ~520), replace the event INSERT with:

```js
    if (approved) {
      const submissionEventType = submission.event_type || 'binary';
      const eventRes = await client.query(
        `INSERT INTO events (title, details, closing_date, category, event_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [submission.title, submission.details, submission.closing_date, submission.category, submissionEventType]
      );
      approvedEventId = eventRes.rows[0].id;

      if (submissionEventType !== 'binary' && Array.isArray(submission.outcome_rows)) {
        await seedEventOutcomes(client, approvedEventId, submissionEventType, submission.outcome_rows);
      }
```

(the bond-return/reward code below stays unchanged).

Note: `submission` in `submitReview` is loaded via `SELECT * ... FOR UPDATE`, so `event_type` and `outcome_rows` (JSONB → already-parsed array from pg) are present without query changes. `normalizeSubmission` spreads the row, so the new fields flow to API responses automatically.

- [ ] **Step 6: Run to verify they pass (plus the untouched pipeline suite)**

Backend test command, `TESTFILE="test/market_question_multi_outcome.test.js test/market_question_validation.test.js"`.
Expected: PASS — including the pre-existing binary pipeline test (regression check).

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/20260705_add_market_question_multi_outcome.sql backend/src/controllers/marketQuestionController.js backend/test/market_question_multi_outcome.test.js
git commit -m "feat(backend): multi-outcome market creation via question pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — API client additions

**Files:**
- Modify: `frontend-solid/src/services/api.js` (`api.events` block line ~654, wrapper exports line ~1069)

**Interfaces:**
- Produces (consumed by Tasks 9-11): `api.events.getMarketState(eventId)`, `api.events.updateOutcome(eventId, {stake, outcome_id})`, `api.events.sellOutcome(eventId, {outcome_id, amount})`, `api.events.resolve(eventId, resolution)` where `resolution` is a string (legacy `'yes'`/`'no'`) or an object (`{outcome_id}` / `{numerical_outcome}`); wrapper exports `getMarketState`, `placeOutcomeUpdate`, `sellOutcomeShares` (and `resolveEvent` passes objects through unchanged).

- [ ] **Step 1: Extend `api.events`**

In `frontend-solid/src/services/api.js`, inside the `events: { ... }` block, replace `resolve` and add three methods after `sell`:

```js
    resolve: (eventId, resolution) =>
      request(`/events/${eventId}`, {
        method: 'PATCH',
        body: typeof resolution === 'string' ? { outcome: resolution } : resolution
      }),
```

```js
    getMarketState: (eventId) =>
      request(`/events/${eventId}/market`),

    updateOutcome: (eventId, { stake, outcome_id }) =>
      request(`/events/${eventId}/update-outcome`, { method: 'POST', body: { stake, outcome_id } }),

    sellOutcome: (eventId, { outcome_id, amount }) =>
      request(`/events/${eventId}/sell-outcome`, { method: 'POST', body: { outcome_id, amount } })
```

- [ ] **Step 2: Add wrapper exports**

Next to `placeEventUpdate` (line ~1078):

```js
export const getMarketState = (eventId) => api.events.getMarketState(eventId);
export const placeOutcomeUpdate = (eventId, { stake, outcome_id }) =>
  api.events.updateOutcome(eventId, { stake, outcome_id });
export const sellOutcomeShares = (eventId, { outcome_id, amount }) =>
  api.events.sellOutcome(eventId, { outcome_id, amount });
```

- [ ] **Step 3: Build check**

Run the frontend build command. Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add frontend-solid/src/services/api.js
git commit -m "feat(frontend): api client for market state and outcome trading

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — extract shared market-card helpers (move-only)

**Files:**
- Create: `frontend-solid/src/components/predictions/marketCardShared.js`
- Modify: `frontend-solid/src/components/predictions/MarketEventCard.jsx:12-56` (delete moved helpers, import instead)

**Interfaces:**
- Produces: named exports `safeNumber`, `formatProbability`, `formatCurrency`, `toDate`, `toShortDate`, `isPhoneVerificationMessage`, `getProbabilityColor`, `getKellyEdge` — bodies identical to today's module-level helpers in `MarketEventCard.jsx` (lines 12-56). Task 9 imports from here.

- [ ] **Step 1: Create the module**

Create `frontend-solid/src/components/predictions/marketCardShared.js` and MOVE (verbatim, adding `export` before each `const`) the helpers from `MarketEventCard.jsx` lines 12-56: `safeNumber`, `formatProbability`, `formatCurrency`, `toDate`, `toShortDate`, `isPhoneVerificationMessage`, `getProbabilityColor`, `getKellyEdge`.

- [ ] **Step 2: Rewire MarketEventCard**

In `MarketEventCard.jsx`, delete the moved definitions and add:

```js
import {
  safeNumber,
  formatProbability,
  formatCurrency,
  toDate,
  toShortDate,
  isPhoneVerificationMessage,
  getProbabilityColor,
  getKellyEdge
} from './marketCardShared';
```

- [ ] **Step 3: Build check**

Run the frontend build command. Expected: clean build (move-only refactor).

- [ ] **Step 4: Commit**

```bash
git add frontend-solid/src/components/predictions/marketCardShared.js frontend-solid/src/components/predictions/MarketEventCard.jsx
git commit -m "refactor(frontend): extract shared market card helpers (move-only)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend — `OutcomeMarketCard` component + styles

**Files:**
- Create: `frontend-solid/src/components/predictions/OutcomeMarketCard.jsx`
- Modify: `frontend-solid/src/styles.css` (append outcome-list styles near the `.event-card` block)

**Interfaces:**
- Consumes: `getMarketState`, `placeOutcomeUpdate`, `sellOutcomeShares`, `getUserPositions` (Task 7 / existing), helpers from `./marketCardShared` (Task 8). Positions rows with `outcome_id`/`outcome_label`/`outcome_shares`/`outcome_staked_rp` (Task 5). Trade responses carrying `outcomes: [{outcome_id, label, prob, lower_bound, upper_bound}]` (engine).
- Produces: `<OutcomeMarketCard event onTrade|onStakeUpdate onVerificationNotice hideTitle predicted />` — same prop contract as `MarketEventCard`. Task 10 renders it.

- [ ] **Step 1: Create the component**

Create `frontend-solid/src/components/predictions/OutcomeMarketCard.jsx`:

```jsx
import { createEffect, createSignal, For, Show } from 'solid-js';
import { getCurrentUserId } from '../../services/auth';
import { getToken } from '../../services/tokenService';
import {
  getMarketState,
  getUserPositions,
  placeOutcomeUpdate,
  sellOutcomeShares
} from '../../services/api';
import { ApiError } from '../../services/api';
import {
  safeNumber,
  formatProbability,
  formatCurrency,
  toDate,
  toShortDate,
  isPhoneVerificationMessage,
  getProbabilityColor
} from './marketCardShared';

const formatOutcomeLabel = (outcome) => {
  const lower = outcome?.lower_bound;
  const upper = outcome?.upper_bound;
  if (Number.isFinite(Number(lower)) && Number.isFinite(Number(upper))) {
    return `${Number(lower)} – ${Number(upper)}`;
  }
  return outcome?.label || 'Outcome';
};

// Trading card for multiple_choice / numeric (bucketed) markets.
// Select an outcome from the list, then buy or sell in the panel below.
export default function OutcomeMarketCard(props) {
  const event = () => props.event || {};
  const hideTitle = props.hideTitle || false;
  const onTrade = () => props.onTrade || props.onStakeUpdate;
  const isLoggedIn = () => !!getToken();
  const eventId = () => event().id;

  const isClosed = () => {
    if (event().outcome) return true;
    const date = toDate(event().closing_date);
    return !!(date && date.getTime() <= Date.now());
  };
  const isOpen = () => !isClosed();

  const [outcomes, setOutcomes] = createSignal([]);
  const [marketLoadState, setMarketLoadState] = createSignal('loading'); // loading | ready | error | unconfigured
  const [selectedOutcomeId, setSelectedOutcomeId] = createSignal(null);
  const [stakeAmount, setStakeAmount] = createSignal('');
  const [positionRows, setPositionRows] = createSignal([]);
  const [busyAction, setBusyAction] = createSignal('');
  const [error, setError] = createSignal('');
  const [tradeMessage, setTradeMessage] = createSignal('');

  let lastEventId = '';

  const closeMessages = () => {
    setError('');
    setTradeMessage('');
  };

  const setVerificationMessage = (message, options = {}) => {
    const normalized = message || '';
    const isVerification = options.requiredTier === 2 || isPhoneVerificationMessage(normalized);
    if (isVerification && props.onVerificationNotice) {
      props.onVerificationNotice(normalized);
    }
    setError(normalized);
  };

  const emitSuccess = (value) => {
    props.onVerificationNotice?.('');
    setTradeMessage(value);
  };

  const selectedOutcome = () =>
    outcomes().find((o) => String(o.outcome_id) === String(selectedOutcomeId())) || null;

  const sharesInOutcome = (outcomeId) => {
    const row = positionRows().find((r) => String(r.outcome_id) === String(outcomeId));
    return safeNumber(row?.outcome_shares);
  };

  const totalStaked = () =>
    positionRows().reduce((acc, row) => acc + safeNumber(row.outcome_staked_rp), 0);

  const positionValue = () =>
    positionRows().reduce((acc, row) => {
      const outcome = outcomes().find((o) => String(o.outcome_id) === String(row.outcome_id));
      return acc + safeNumber(row.outcome_shares) * safeNumber(outcome?.prob);
    }, 0);

  const hasPosition = () => positionRows().some((row) => safeNumber(row.outcome_shares) > 0);

  const loadMarketState = async () => {
    if (!eventId()) return;
    setMarketLoadState('loading');
    try {
      const state = await getMarketState(eventId());
      const rows = Array.isArray(state?.outcomes) ? state.outcomes : [];
      if (rows.length < 2) {
        setOutcomes([]);
        setMarketLoadState('unconfigured');
        return;
      }
      setOutcomes(rows);
      setMarketLoadState('ready');
      if (!rows.some((o) => String(o.outcome_id) === String(selectedOutcomeId()))) {
        setSelectedOutcomeId(rows[0].outcome_id);
      }
    } catch (err) {
      setOutcomes([]);
      setMarketLoadState('error');
    }
  };

  const loadPositions = async () => {
    if (!isLoggedIn()) {
      setPositionRows([]);
      return;
    }
    const currentUserId = getCurrentUserId();
    if (!currentUserId || !eventId()) {
      setPositionRows([]);
      return;
    }
    try {
      const positions = await getUserPositions(currentUserId);
      if (!Array.isArray(positions)) {
        setPositionRows([]);
        return;
      }
      setPositionRows(positions.filter(
        (row) => String(row.event_id) === String(eventId()) && row.outcome_id != null
      ));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message, { requiredTier: err.data?.required_tier });
      }
      setPositionRows([]);
    }
  };

  const applyTradeResult = (result) => {
    if (Array.isArray(result?.outcomes) && result.outcomes.length > 0) {
      setOutcomes(result.outcomes);
    }
  };

  const handleBuy = async (eventObj) => {
    eventObj?.preventDefault?.();
    if (!isOpen()) {
      setError('Market is closed or resolved.');
      return;
    }
    if (!isLoggedIn()) {
      setVerificationMessage('Please log in first.');
      return;
    }
    const outcome = selectedOutcome();
    if (!outcome) {
      setError('Select an outcome first.');
      return;
    }
    const amount = safeNumber(stakeAmount(), 0);
    if (!amount || amount <= 0) {
      setError('Stake amount must be greater than zero.');
      return;
    }

    closeMessages();
    setBusyAction('buy');
    try {
      const result = await placeOutcomeUpdate(eventId(), {
        stake: amount,
        outcome_id: Number(outcome.outcome_id)
      });
      applyTradeResult(result);
      await loadPositions();
      setStakeAmount('');
      emitSuccess(`Bought ${safeNumber(result?.shares_acquired).toFixed(2)} shares of "${formatOutcomeLabel(outcome)}".`);
      await onTrade()?.(eventId());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message || 'Verification required to place trade.', {
          requiredTier: err.data?.required_tier
        });
      } else {
        setError(err?.message || 'Failed to place stake.');
      }
    } finally {
      setBusyAction('');
    }
  };

  const handleSell = async () => {
    if (!isOpen()) {
      setError('Market is closed or resolved.');
      return;
    }
    const outcome = selectedOutcome();
    if (!outcome) {
      setError('Select an outcome first.');
      return;
    }
    const held = sharesInOutcome(outcome.outcome_id);
    if (held <= 0) {
      setError('No shares to sell in the selected outcome.');
      return;
    }

    const estimated = held * safeNumber(outcome.prob);
    const ok = window.confirm(
      `Confirm sale:\n\n` +
      `Sell ${held.toFixed(2)} shares of "${formatOutcomeLabel(outcome)}"\n` +
      `Estimated payout: ${estimated.toFixed(2)} RP\n\n` +
      `Do you want to proceed?`
    );
    if (!ok) return;

    closeMessages();
    setBusyAction('sell');
    try {
      const result = await sellOutcomeShares(eventId(), {
        outcome_id: Number(outcome.outcome_id),
        amount: held
      });
      applyTradeResult(result);
      await loadPositions();
      emitSuccess(`Sold ${held.toFixed(2)} shares for ${safeNumber(result?.payout).toFixed(2)} RP.`);
      await onTrade()?.(eventId());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message || 'Verification required to sell shares.', {
          requiredTier: err.data?.required_tier
        });
      } else {
        setError(err?.message || 'Failed to sell shares.');
      }
    } finally {
      setBusyAction('');
    }
  };

  createEffect(() => {
    const nextId = String(eventId());
    if (nextId !== lastEventId) {
      lastEventId = nextId;
      setSelectedOutcomeId(null);
      void loadMarketState();
      if (isLoggedIn()) {
        void loadPositions();
      } else {
        setPositionRows([]);
      }
    }
  });

  return (
    <div class="event-card outcome-market-card">
      <div style={{ flex: '1 1 auto' }}>
        <Show when={!hideTitle}>
          <div class="event-header">
            <h3 class="event-title">{event().title || 'Untitled market'}</h3>
            <div class="event-meta">
              <span class="event-category">{event().category || 'General'}</span>
              <span class="event-closing">{`Closes: ${toShortDate(event().closing_date)}`}</span>
            </div>
          </div>
        </Show>

        <div class="market-state">
          <div class="market-stats">
            <div class="stat">
              <span class="stat-label">Event Type:</span>
              <span class="stat-value">{event().event_type === 'numeric' ? 'numeric buckets' : 'multiple choice'}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Total RP Staked:</span>
              <span class="stat-value">{formatCurrency(Math.max(0, safeNumber(event().cumulative_stake)), { includeSymbol: false })}</span>
            </div>
          </div>
        </div>

        <Show when={props?.predicted}>
          <p class="prediction-outcome muted">You already submitted a forecast prediction for this market.</p>
        </Show>

        <Show when={marketLoadState() === 'loading'}>
          <p class="muted">Loading outcomes...</p>
        </Show>

        <Show when={marketLoadState() === 'error'}>
          <div class="outcome-market-degraded">
            <p class="muted">Prices unavailable.</p>
            <button type="button" class="button" onClick={() => void loadMarketState()}>Retry</button>
          </div>
        </Show>

        <Show when={marketLoadState() === 'unconfigured'}>
          <p class="muted">This market's outcomes are not configured yet. Trading opens once they are.</p>
        </Show>

        <Show when={marketLoadState() === 'ready'}>
          <div class="outcome-list" role="radiogroup" aria-label="Market outcomes">
            <For each={outcomes()}>
              {(outcome) => (
                <button
                  type="button"
                  class={`outcome-row ${String(selectedOutcomeId()) === String(outcome.outcome_id) ? 'selected' : ''}`}
                  role="radio"
                  aria-checked={String(selectedOutcomeId()) === String(outcome.outcome_id)}
                  onClick={() => setSelectedOutcomeId(outcome.outcome_id)}
                  disabled={!!busyAction()}
                >
                  <span class="outcome-label">{formatOutcomeLabel(outcome)}</span>
                  <span class="outcome-meta">
                    <Show when={sharesInOutcome(outcome.outcome_id) > 0}>
                      <span class="outcome-user-shares">{`${sharesInOutcome(outcome.outcome_id).toFixed(2)} sh`}</span>
                    </Show>
                    <span class="outcome-prob" style={{ color: getProbabilityColor(outcome.prob) }}>
                      {formatProbability(outcome.prob)}
                    </span>
                  </span>
                </button>
              )}
            </For>
          </div>

          <Show when={isOpen()} fallback={<p class="muted">Market is closed or resolved.</p>}>
            <Show when={isLoggedIn()} fallback={
              <div class="login-prompt">
                <p>Log in to trade outcomes in this market</p>
                <button type="button" class="button" onClick={() => { window.location.hash = 'login'; }}>
                  Log In
                </button>
              </div>
            }>
              <form class="betting-form outcome-trade-panel" onSubmit={handleBuy}>
                <div class="outcome-trade-summary">
                  <Show when={selectedOutcome()} fallback={<span class="muted">Select an outcome above.</span>}>
                    <span>
                      {`Trading: ${formatOutcomeLabel(selectedOutcome())} @ ${formatProbability(selectedOutcome()?.prob)}`}
                    </span>
                  </Show>
                </div>
                <div class="form-row horizontal-row">
                  <div class="form-field">
                    <label for={`outcome-stake-${eventId()}`}>Stake Amount (RP):</label>
                    <input
                      id={`outcome-stake-${eventId()}`}
                      class="stake-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="Enter stake amount"
                      value={stakeAmount()}
                      onInput={(e) => setStakeAmount(e.target.value)}
                    />
                  </div>
                  <div class="form-actions outcome-trade-actions">
                    <button
                      type="submit"
                      class="button primary"
                      disabled={!stakeAmount() || !selectedOutcome() || !!busyAction()}
                    >
                      {busyAction() === 'buy' ? 'Buying...' : 'Buy'}
                    </button>
                    <button
                      type="button"
                      class="button secondary"
                      onClick={() => void handleSell()}
                      disabled={!selectedOutcome() || sharesInOutcome(selectedOutcomeId()) <= 0 || !!busyAction()}
                    >
                      {busyAction() === 'sell'
                        ? 'Selling...'
                        : `Sell (${sharesInOutcome(selectedOutcomeId()).toFixed(2)})`}
                    </button>
                  </div>
                </div>
              </form>
            </Show>
          </Show>
        </Show>
      </div>

      <div style={{ flex: '0 0 auto', marginTop: 'auto' }}>
        <Show when={hasPosition()}>
          <div class="user-position">
            <div class="position-stats">
              <div class="stat">
                <span class="stat-label">Your Stake:</span>
                <span class="stat-value">{formatCurrency(totalStaked())}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Position Value:</span>
                <span class="stat-value">{formatCurrency(positionValue())}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Unrealized P&L:</span>
                <span class={`stat-value ${positionValue() - totalStaked() >= 0 ? 'positive' : 'negative'}`}>
                  {formatCurrency(positionValue() - totalStaked())}
                </span>
              </div>
            </div>
          </div>
        </Show>

        <Show when={tradeMessage()}>
          <p class="success">{tradeMessage()}</p>
        </Show>
        <Show when={error()}>
          <p class="error-message">{error()}</p>
        </Show>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add styles**

Append to `frontend-solid/src/styles.css` (near the existing `.event-card` rules; keep plain so `skin-terminal`/`skin-van` inherit):

```css
/* Multi-outcome market card */
.outcome-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0.75rem 0;
  max-height: 16rem;
  overflow-y: auto;
}

.outcome-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color, #333);
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}

.outcome-row.selected {
  border-width: 2px;
  font-weight: 700;
}

.outcome-row:disabled {
  opacity: 0.6;
  cursor: default;
}

.outcome-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.outcome-user-shares {
  font-size: 0.85em;
  opacity: 0.75;
}

.outcome-prob {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.outcome-trade-summary {
  margin-bottom: 0.5rem;
}

.outcome-trade-actions {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
}
```

- [ ] **Step 3: Build check**

Run the frontend build command. Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add frontend-solid/src/components/predictions/OutcomeMarketCard.jsx frontend-solid/src/styles.css
git commit -m "feat(frontend): OutcomeMarketCard select-then-trade component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Frontend — dispatch by event_type in EventsList

**Files:**
- Modify: `frontend-solid/src/components/predictions/EventsList.jsx` (imports line ~3; render spots lines ~287 and ~322)

**Interfaces:**
- Consumes: `OutcomeMarketCard` (Task 9).
- Produces: multiple_choice/numeric events render `OutcomeMarketCard`; binary (and everything else) keeps `MarketEventCard`.

- [ ] **Step 1: Add import + helper**

In `EventsList.jsx`, after `import MarketEventCard from './MarketEventCard';`:

```js
import OutcomeMarketCard from './OutcomeMarketCard';

const isMultiOutcome = (eventItem) =>
  ['multiple_choice', 'numeric'].includes(eventItem?.event_type);
```

- [ ] **Step 2: Dispatch at both render spots**

Replace the `<MarketEventCard ... />` in `renderSelectedEvent()` (line ~287) with:

```jsx
          <Show
            when={isMultiOutcome(selectedEvent())}
            fallback={
              <MarketEventCard
                event={selectedEvent()}
                onTrade={handleTradeRefresh}
                onVerificationNotice={props.onVerificationNotice}
                hideTitle={true}
                authenticated={authed()}
              />
            }
          >
            <OutcomeMarketCard
              event={selectedEvent()}
              onTrade={handleTradeRefresh}
              onVerificationNotice={props.onVerificationNotice}
              hideTitle={true}
            />
          </Show>
```

And the weekly-assignment `<MarketEventCard ... />` (line ~322) with the same `Show`/fallback pattern using `assignedEvent` as the event and the same `onTrade={handleTradeRefresh}` / `onVerificationNotice` props (no `authenticated` prop there, matching the current call).

- [ ] **Step 3: Build check**

Run the frontend build command. Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add frontend-solid/src/components/predictions/EventsList.jsx
git commit -m "feat(frontend): dispatch multi-outcome events to OutcomeMarketCard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Frontend — outcome-aware admin resolution

**Files:**
- Modify: `frontend-solid/src/components/predictions/AdminMarketResolution.jsx`

**Interfaces:**
- Consumes: `getMarketState` (Task 7), `resolveEvent` accepting object payloads (Task 7), backend `PATCH /events/:id` (existing).
- Produces: admin can resolve `multiple_choice` by outcome dropdown (`{outcome_id}`) and `numeric` by value input (`{numerical_outcome}`); binary flow unchanged.

- [ ] **Step 1: Extend the component**

Modify `AdminMarketResolution.jsx`:

(a) Imports — add `createEffect` to the solid-js import and `getMarketState` to the api import:

```js
import { createEffect, createSignal, For, onMount, Show } from 'solid-js';
import { getEvents, getMarketState, resolveEvent } from '../../services/api';
```

(b) New signals after `outcome` (line ~11):

```js
  const [marketOutcomes, setMarketOutcomes] = createSignal([]);
  const [selectedOutcomeId, setSelectedOutcomeId] = createSignal('');
  const [numericValue, setNumericValue] = createSignal('');
  const [outcomesLoading, setOutcomesLoading] = createSignal(false);
```

(c) Helpers after `loadEvents`:

```js
  const selectedEvent = () =>
    events().find((e) => String(e.id) === String(selectedEventId())) || null;
  const isMultipleChoice = () => selectedEvent()?.event_type === 'multiple_choice';
  const isNumeric = () => selectedEvent()?.event_type === 'numeric';

  createEffect(() => {
    const current = selectedEvent();
    setSelectedOutcomeId('');
    setNumericValue('');
    setMarketOutcomes([]);
    if (current && current.event_type === 'multiple_choice') {
      setOutcomesLoading(true);
      getMarketState(current.id)
        .then((state) => setMarketOutcomes(Array.isArray(state?.outcomes) ? state.outcomes : []))
        .catch(() => setMarketOutcomes([]))
        .finally(() => setOutcomesLoading(false));
    }
  });
```

(d) Replace the `resolveEvent(selectedEventId(), outcome())` call inside `handleResolve` (line ~52) with:

```js
      if (isMultipleChoice()) {
        if (!selectedOutcomeId()) {
          setError('Select the winning outcome.');
          setResolving(false);
          return;
        }
        await resolveEvent(selectedEventId(), { outcome_id: Number(selectedOutcomeId()) });
        setMessage('Market resolved to the selected outcome.');
      } else if (isNumeric()) {
        const value = Number(numericValue());
        if (!Number.isFinite(value)) {
          setError('Enter the resolved numeric value.');
          setResolving(false);
          return;
        }
        await resolveEvent(selectedEventId(), { numerical_outcome: value });
        setMessage(`Market resolved at ${value}.`);
      } else {
        await resolveEvent(selectedEventId(), outcome());
        setMessage(`Market resolved as ${outcome().toUpperCase()}.`);
      }
```

(also remove the now-duplicated `setMessage(...)` line that followed the old call, and reset the new signals where `setSelectedEventId('')`/`setOutcome('yes')` are reset).

(e) Replace the outcome form-group JSX (lines ~93-113) with a type-aware block:

```jsx
        <Show when={isMultipleChoice()}>
          <div class="form-group">
            <label for="resolve-outcome">Winning outcome:</label>
            {outcomesLoading() ? (
              <div class="loading-events"><span>Loading outcomes...</span></div>
            ) : (
              <select
                id="resolve-outcome"
                required
                disabled={resolving()}
                value={selectedOutcomeId()}
                onChange={(target) => setSelectedOutcomeId(target.currentTarget.value)}
              >
                <option value="">-- Select the winning outcome --</option>
                <For each={marketOutcomes()}>
                  {(outcomeItem) => (
                    <option value={outcomeItem.outcome_id}>{outcomeItem.label}</option>
                  )}
                </For>
              </select>
            )}
          </div>
        </Show>

        <Show when={isNumeric()}>
          <div class="form-group">
            <label for="resolve-numeric">Resolved value:</label>
            <input
              id="resolve-numeric"
              type="number"
              step="any"
              disabled={resolving()}
              value={numericValue()}
              onInput={(e) => setNumericValue(e.target.value)}
              placeholder="Actual numeric outcome"
            />
          </div>
        </Show>

        <Show when={!isMultipleChoice() && !isNumeric()}>
          <div class="form-group">
            <label>Outcome:</label>
            <div class="trade-direction">
              <button
                type="button"
                class={`button ${outcome() === 'no' ? 'active-trade-direction' : ''}`}
                onClick={() => setOutcome('no')}
                disabled={resolving()}
              >
                Resolve No
              </button>
              <button
                type="button"
                class={`button ${outcome() === 'yes' ? 'active-trade-direction' : ''}`}
                onClick={() => setOutcome('yes')}
                disabled={resolving()}
              >
                Resolve Yes
              </button>
            </div>
          </div>
        </Show>
```

- [ ] **Step 2: Build check**

Run the frontend build command. Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add frontend-solid/src/components/predictions/AdminMarketResolution.jsx
git commit -m "feat(frontend): resolve multiple_choice/numeric markets from admin panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Frontend — multi-outcome creation in the question submission form

**Files:**
- Modify: `frontend-solid/src/components/predictions/MarketQuestionHub.jsx` (`createSubmission` line ~152, `renderSubmissionForm` line ~256, signals near the top of the component)

**Interfaces:**
- Consumes: `createMarketQuestion(payload)` (existing wrapper — passes body through) hitting Task 6's extended `POST /api/market-questions`.
- Produces: submission payloads may carry `event_type: 'multiple_choice'` + `outcomes: [labels]`, or `event_type: 'numeric'` + `numeric_buckets: [{lower_bound, upper_bound}]`.

- [ ] **Step 1: Add signals**

Next to the existing form signals (`title`, `details`, `category`, `closingDate`):

```js
  const [eventType, setEventType] = createSignal('binary');
  const [outcomeLabels, setOutcomeLabels] = createSignal(['', '']);
  const [bucketBoundaries, setBucketBoundaries] = createSignal('');
```

- [ ] **Step 2: Add client-side validation + payload assembly**

In `createSubmission`, after the existing `getValidationError` check and before `setCreating(true)`:

```js
    const payloadExtras = {};
    if (eventType() === 'multiple_choice') {
      const labels = outcomeLabels().map((l) => String(l).trim()).filter(Boolean);
      const uniqueLabels = new Set(labels.map((l) => l.toLowerCase()));
      if (labels.length < 2) {
        setErrors('Multiple choice questions need at least two outcomes.');
        return;
      }
      if (labels.length > 10) {
        setErrors('At most 10 outcomes allowed.');
        return;
      }
      if (uniqueLabels.size !== labels.length) {
        setErrors('Outcome labels must be unique.');
        return;
      }
      payloadExtras.event_type = 'multiple_choice';
      payloadExtras.outcomes = labels;
    } else if (eventType() === 'numeric') {
      const bounds = String(bucketBoundaries())
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      const sorted = [...bounds].sort((a, b) => a - b);
      const strictlyIncreasing = sorted.every((v, i) => i === 0 || v > sorted[i - 1]);
      if (bounds.length < 3 || !strictlyIncreasing) {
        setErrors('Enter at least 3 strictly increasing boundaries (e.g. "0, 10, 20") — they define the buckets.');
        return;
      }
      payloadExtras.event_type = 'numeric';
      payloadExtras.numeric_buckets = sorted.slice(0, -1).map((lower, i) => ({
        lower_bound: lower,
        upper_bound: sorted[i + 1]
      }));
    }
```

Then spread into the existing payload (`const payload = { ...payloadExtras, title: ..., ... }`) and, in the success branch, reset: `setEventType('binary'); setOutcomeLabels(['', '']); setBucketBoundaries('');`.

- [ ] **Step 3: Extend the form JSX**

In `renderSubmissionForm()`, after the closing-date field and before the actions div:

```jsx
        <label for="mq-event-type">Question type</label>
        <select
          id="mq-event-type"
          value={eventType()}
          onChange={(e) => setEventType(e.currentTarget.value)}
        >
          <option value="binary">Binary (yes / no)</option>
          <option value="multiple_choice">Multiple choice</option>
          <option value="numeric">Numeric buckets</option>
        </select>

        <Show when={eventType() === 'multiple_choice'}>
          <label>Outcomes (2–10)</label>
          <For each={outcomeLabels()}>
            {(label, index) => (
              <div class="mq-outcome-row">
                <input
                  type="text"
                  value={label}
                  placeholder={`Outcome ${index() + 1}`}
                  onInput={(e) => {
                    const next = [...outcomeLabels()];
                    next[index()] = e.target.value;
                    setOutcomeLabels(next);
                  }}
                />
                <Show when={outcomeLabels().length > 2}>
                  <button
                    type="button"
                    class="button"
                    onClick={() => setOutcomeLabels(outcomeLabels().filter((_, i) => i !== index()))}
                  >
                    Remove
                  </button>
                </Show>
              </div>
            )}
          </For>
          <Show when={outcomeLabels().length < 10}>
            <button
              type="button"
              class="button"
              onClick={() => setOutcomeLabels([...outcomeLabels(), ''])}
            >
              Add outcome
            </button>
          </Show>
        </Show>

        <Show when={eventType() === 'numeric'}>
          <label for="mq-bucket-bounds">Bucket boundaries (comma-separated, ascending)</label>
          <input
            id="mq-bucket-bounds"
            type="text"
            value={bucketBoundaries()}
            placeholder="e.g. 0, 10, 20, 50"
            onInput={(e) => setBucketBoundaries(e.target.value)}
          />
          <p class="muted">N boundaries create N−1 buckets, e.g. "0, 10, 20" → [0–10), [10–20).</p>
        </Show>
```

(`For` is already imported in this file; verify `Show` is too, add if missing.)

- [ ] **Step 4: Build check**

Run the frontend build command. Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/components/predictions/MarketQuestionHub.jsx
git commit -m "feat(frontend): multi-outcome question types in submission form

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: E2E test + integration verification (post-merge)

**Files:**
- Create: `tests/e2e/multi-outcome-trading.spec.js`
- No production code changes.

**Interfaces:**
- Consumes: the full deployed stack (all previous tasks), E2E users `user1@example.com / password123`.

**IMPORTANT — coordination gate:** the running containers serve the MAIN checkout. This task requires the branch merged and deployed. STOP and confirm with the user before merging (another session works in the main checkout). Follow superpowers:finishing-a-development-branch for the merge decision.

- [ ] **Step 1: Write the E2E spec** (in the worktree; it ships with the branch)

Create `tests/e2e/multi-outcome-trading.spec.js`:

```js
// E2E: multi-outcome trading loop.
// Seeds a multiple_choice event directly in the DB, then drives the UI:
// select event -> pick outcome -> buy -> price shifts -> sell -> position gone.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('multi-outcome trading', () => {
  let eventId;
  const title = `E2E MC market ${Date.now()}`;

  test.beforeAll(() => {
    eventId = Number(psql(
      `INSERT INTO events (title, details, closing_date, event_type, liquidity_b)
       VALUES ('${title}', 'e2e seed', NOW() + INTERVAL '7 days', 'multiple_choice', 5000)
       RETURNING id`
    ));
    const o1 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventId}, 'choice_1', 'Alpha', 0) RETURNING id`
    ));
    const o2 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventId}, 'choice_2', 'Beta', 1) RETURNING id`
    ));
    psql(
      `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
       VALUES (${eventId}, ${o1}, 0, 0.5), (${eventId}, ${o2}, 0, 0.5)`
    );
  });

  test.afterAll(() => {
    if (eventId) psql(`DELETE FROM events WHERE id = ${eventId}`);
  });

  test('buy then sell an outcome via the UI', async ({ page }) => {
    await page.goto('http://localhost:4174/#login');
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /log in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });

    await page.goto('http://localhost:4174/#predictions');
    await page.getByPlaceholder(/search/i).fill(title);
    await page.getByText(title, { exact: false }).first().click();

    const card = page.locator('.outcome-market-card');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator('.outcome-row')).toHaveCount(2);

    const alphaRow = card.locator('.outcome-row', { hasText: 'Alpha' });
    await expect(alphaRow.locator('.outcome-prob')).toHaveText(/50\.0%/);
    await alphaRow.click();

    await card.locator('.stake-input').fill('100');
    await card.getByRole('button', { name: /^buy$/i }).click();
    await expect(card.locator('.success')).toContainText(/bought/i, { timeout: 10000 });

    // Price moved off 50% and a position exists.
    await expect(alphaRow.locator('.outcome-prob')).not.toHaveText(/50\.0%/);
    await expect(card.locator('.user-position')).toBeVisible();

    // Sell it all back.
    page.on('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: /sell \(/i }).click();
    await expect(card.locator('.success')).toContainText(/sold/i, { timeout: 10000 });
    await expect(card.locator('.user-position')).not.toBeVisible();
  });
});
```

Commit it:

```bash
git add tests/e2e/multi-outcome-trading.spec.js
git commit -m "test(e2e): multi-outcome buy/sell trading loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Merge gate (ASK THE USER)**

Present merge options per superpowers:finishing-a-development-branch. Do not merge or touch the main checkout without explicit confirmation — the other session is working there.

- [ ] **Step 3: Deploy (after merge approval, in the MAIN checkout)**

```bash
cd /var/opt/docker/intellacc.com
git merge multi-outcome-trading-ui   # or the user's chosen integration route
docker compose up -d --build prediction-engine backend frontend-solid
```

Migrations auto-run on backend start. Watch: `docker logs --tail 50 intellacc_backend`.

- [ ] **Step 4: Run the E2E test**

```bash
cd /var/opt/docker/intellacc.com
./tests/e2e/reset-test-users.sh
npx playwright test tests/e2e/multi-outcome-trading.spec.js
```

Expected: PASS. If selectors drift from the actual login/predictions pages, fix the spec (not the app) and re-run.

- [ ] **Step 5: Invariant + resolution smoke check**

```bash
# user1's balance invariants still hold after the trade loop
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c \
  "SELECT id, rp_balance_ledger, rp_staked_ledger FROM users WHERE email = 'user1@example.com';"
```

Expected: `rp_staked_ledger` back to its pre-test value (full exit) and no negative ledgers. Then, as a manual smoke: log in as an admin, open Predictions → admin section, resolve a seeded multiple_choice event to an outcome, and confirm the winning-outcome payout lands (or verify via `PATCH /api/events/:id` with an admin token and `{ "outcome_id": <id> }`).

- [ ] **Step 6: Final verification**

Use superpowers:verification-before-completion — all backend suites, engine `cargo test`, frontend build, E2E pass, before declaring done.

---

## Self-Review Notes

- **Spec coverage:** trading buy (Tasks 7/9/10), sell engine→UI (1/2/4/9), positions (5), resolution (11), creation (6/12), numeric buckets (shared code paths in 6/9/12), error handling (9 degraded states, 2/4 error mapping), tests (1/4/5/6/13). Out-of-scope items from the spec are untouched.
- **Type consistency:** engine response field names (`payout`, `market_prob`, `current_cost_c`, `outcomes[].outcome_id/label/prob/lower_bound/upper_bound`, `shares_acquired`) match across Task 2 (producer), Task 4 (proxy pass-through + socket), and Task 9 (consumer). Positions row fields (`outcome_id`, `outcome_label`, `outcome_shares`, `outcome_staked_rp`) match between Task 5 SQL and Task 9's `sharesInOutcome`/`totalStaked`.
- **Known judgment calls:** no journal row on outcome sells (matches binary behavior); `outcome_rows` JSONB stores normalized rows; the E2E spec's selectors are best-effort against the real pages and may need adjustment at run time.
