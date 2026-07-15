# LMSR Numeric-Markets Fast-Follow Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the post-ship backlog of the 50-bin numeric-markets feature: engine hardening (quote pre-checks, invariant coverage, batched settlement, tracing), frontend nits (numeric header %, MyPositions meta line, RP refresh, Sell decoupling, error copy), the E2E staked-RP leak, and the manual-resolution ops runbook.

**Architecture:** Eleven independent tasks against the shipped numeric-markets stack: Rust prediction engine (`prediction-engine/src/lmsr_api.rs`, `main.rs`, `db_adapter.rs`), SolidJS frontend (`frontend-solid/src/components/predictions/*`), Playwright E2E harness (`tests/e2e/*`), and one ops document. Engine tasks come first (Task 2 produces an interface Task 9 consumes); frontend tasks run against the source-mounted solid-local dev container; nothing deploys to production until the final gate.

**Tech Stack:** Rust (Axum, SQLx, tokio, tracing), SolidJS, PostgreSQL, Playwright, bash.

## Global Constraints

- **This machine hosts production.** Never touch the `intellacc_frontend_solid` container except at the final deploy step (`docker restart intellacc_frontend_solid`). Verify production only at https://intellacc.de — NEVER at localhost:4174, which is the solid-local DEV container serving the working tree.
- E2E specs run against the solid-local dev instance at `http://localhost:4174` (container `intellacc_frontend_solid_local`, currently up). If it is down: `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` — the `-p solid-local` flag is MANDATORY (without it the command replaces the production container).
- The backend is source-mounted but does NOT hot-reload: after any `backend/src` change, `docker restart intellacc_backend` before verifying via HTTP/E2E.
- The engine builds in Docker only (no host cargo): `docker compose up -d --build prediction-engine` from the repo root. Engine tests: `./scripts/test_prediction_engine.sh` (lib tests) and `./scripts/test_prediction_engine.sh --full` (includes DB-backed integration tests).
- **Engine test-schema trap:** `prediction-engine/src/integration_tests.rs::setup_test_database()` builds its OWN minimal schema. Any engine query touching a new table/column needs a matching stand-in `CREATE TABLE IF NOT EXISTS` there, or CI errors with "relation does not exist". Never `.map_err` over a guard/DB call — it masks DB errors as domain rejections.
- Money paths keep i64/i128 ledger arithmetic (LEDGER_SCALE = 1_000_000), preserve the per-row non-negative guards on `users.rp_balance_ledger`/`rp_staked_ledger`, and never derive unstake amounts from float sums — basis comes from `numeric_position_basis`.
- E2E specs that trade with shared accounts (user1/user2) must refund staked RP before deleting fixture events (event delete cascades share rows but NOT `users.rp_staked_ledger`).
- Never run `backend/weekly_cron.js` manually (RP decay side effect).
- Commits go directly on master, one per task, message style `fix(numeric-markets): …` / `feat(engine): …` / `test(e2e): …` / `docs(ops): …`. After the final push, `gh run watch` both workflows to green.
- Error copy exact values: engine 400 body for span clamp is `"Market too extreme or target too concentrated for the current liquidity; reduce the requested move"` (already shipped — do not change the engine string). Frontend remap (Task 9): `"Your target is too concentrated for this market's liquidity — widen your P10–P90 range or reduce the trade size."`
- MyPositions numeric meta line format (Task 7): `Distribution · {binsHeld} bins · {totalShares.toFixed(1)} sh`.

---

### Task 1: Engine — numeric-quote rejects closed/resolved markets

`get_numeric_quote` (`prediction-engine/src/lmsr_api.rs:1417-1455`) fetches `is_resolved`/`is_closed` via `NUMERIC_MARKET_ROW_QUERY` but never reads them; the trade/sell paths check both (`lmsr_api.rs:1497-1503`, `1697-1703`). Users only learn a market is closed when the trade POST fails.

**Files:**
- Modify: `prediction-engine/src/lmsr_api.rs` (~line 1427, right after `fetch_numeric_market_row_pool`)
- Modify: `prediction-engine/src/integration_tests.rs` (new test + `event_outcome_states` stand-in table)

**Interfaces:**
- Consumes: `ERR_MARKET_RESOLVED` / `ERR_MARKET_CLOSED` constants (`lmsr_api.rs:20-21`); `numeric_error_response` in `main.rs:1179-1208` already maps these to 400 "Market resolved"/"Market closed".
- Produces: `get_numeric_quote` errors with `Market resolved` / `Market closed` before doing any math.

- [ ] **Step 1: Add stand-in table to the integration-test schema**

In `setup_test_database()` in `integration_tests.rs`, after the existing `numeric_market_config` stand-in (line ~295), add:

```rust
sqlx::query(
    r#"
    CREATE TABLE IF NOT EXISTS event_outcome_states (
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
        q_value DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        prob DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, outcome_id)
    )
    "#,
)
.execute(pool)
.await?;
```

(Read the surrounding stand-ins first and match their exact style/placement. Check the stand-in `events` table has `event_type` and `outcome` columns — it should, the resolver guards already query them.)

- [ ] **Step 2: Write the failing test**

Add to the tests module of `integration_tests.rs` (reuse the file's existing setup helpers where they exist — read a neighboring test first):

```rust
#[tokio::test]
async fn test_numeric_quote_rejects_closed_and_resolved() -> Result<()> {
    let pool = setup_test_database().await?;

    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('closed numeric market', NOW() - INTERVAL '1 hour', 'numeric') RETURNING id",
    )
    .fetch_one(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric)
         VALUES ($1, 0, 4, 4, 886.0)",
    )
    .bind(event_id)
    .execute(&pool)
    .await?;
    for i in 0..4i32 {
        let outcome_id: i64 = sqlx::query_scalar(
            "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        )
        .bind(event_id)
        .bind(format!("bin_{i}"))
        .bind(format!("{i}-{}", i + 1))
        .bind(i)
        .bind(i as f64)
        .bind((i + 1) as f64)
        .fetch_one(&pool)
        .await?;
        sqlx::query(
            "INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
             VALUES ($1, $2, 0, 0.25)",
        )
        .bind(event_id)
        .bind(outcome_id)
        .execute(&pool)
        .await?;
    }

    let target = vec![0.25f64; 4];

    // Closed (past closing_date, unresolved) must be rejected.
    let err = crate::lmsr_api::get_numeric_quote(&pool, event_id, 1_000_000, target.clone())
        .await
        .expect_err("quote on closed market must fail");
    assert!(err.to_string().contains("Market closed"), "got: {err}");

    // Resolved (outcome set) must be rejected even if closing_date is future.
    sqlx::query(
        "UPDATE events SET outcome = 'resolved_bin_2', closing_date = NOW() + INTERVAL '1 day'
         WHERE id = $1",
    )
    .bind(event_id)
    .execute(&pool)
    .await?;
    let err = crate::lmsr_api::get_numeric_quote(&pool, event_id, 1_000_000, target.clone())
        .await
        .expect_err("quote on resolved market must fail");
    assert!(err.to_string().contains("Market resolved"), "got: {err}");

    // Control: open + unresolved must still quote successfully.
    sqlx::query("UPDATE events SET outcome = NULL WHERE id = $1")
        .bind(event_id)
        .execute(&pool)
        .await?;
    crate::lmsr_api::get_numeric_quote(&pool, event_id, 1_000_000, target)
        .await
        .expect("quote on open market must succeed");
    Ok(())
}
```

- [ ] **Step 3: Run the test, verify it fails on the closed assertion**

Run: `CARGO_TEST_ARGS="integration_tests::tests::test_numeric_quote_rejects_closed_and_resolved -- --nocapture" bash -c 'cd /var/opt/docker/intellacc.com && docker compose -f prediction-engine/docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from prediction-engine-tests prediction-engine-tests; docker compose -f prediction-engine/docker-compose.test.yml down -v --remove-orphans'`

(Adjust the test-path filter to the actual module path — check how the 5 existing integration tests are namespaced.)
Expected: FAIL — `quote on closed market must fail` panics because the quote currently succeeds.

- [ ] **Step 4: Implement the check**

In `get_numeric_quote`, immediately after `let market = fetch_numeric_market_row_pool(pool, event_id).await?;`:

```rust
if market.is_resolved {
    return Err(anyhow!(ERR_MARKET_RESOLVED));
}
if market.is_closed {
    return Err(anyhow!(ERR_MARKET_CLOSED));
}
```

- [ ] **Step 5: Re-run the test — PASS. Then run the full engine suite**

Run: `./scripts/test_prediction_engine.sh --full`
Expected: all tests pass (46+ lib, 5+ integration).

- [ ] **Step 6: Commit**

```bash
git add prediction-engine/src/lmsr_api.rs prediction-engine/src/integration_tests.rs
git commit -m "fix(numeric-markets): reject quotes on closed/resolved numeric markets"
```

---

### Task 2: Engine — expose `numeric_market_version` in GET /events/:id/market

The Sell path needs a `market_version` for optimistic concurrency but currently steals it from the budget-driven trade quote (Task 9 fixes the frontend side). Add the version to the market-state response.

**Files:**
- Modify: `prediction-engine/src/lmsr_api.rs:2240-2268` (`get_market_state` SQL + JSON at ~2383)
- Modify: `prediction-engine/src/integration_tests.rs` (new test)
- Verify (read-only unless it filters fields): backend proxy for `GET /api/events/:id/market` in `backend/src/controllers/predictionsController.js`

**Interfaces:**
- Produces: market-state JSON gains `"numeric_market_version": <i64 | null>` — `null` for non-numeric events. Task 9 consumes this via `getMarketState()` in the frontend.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn test_market_state_exposes_numeric_market_version() -> Result<()> {
    let pool = setup_test_database().await?;
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('numeric version probe', NOW() + INTERVAL '7 days', 'numeric') RETURNING id",
    )
    .fetch_one(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric, numeric_market_version)
         VALUES ($1, 0, 4, 4, 886.0, 7)",
    )
    .bind(event_id)
    .execute(&pool)
    .await?;
    // two active outcomes so the non-binary branch has rows to serialize
    for i in 0..2i32 {
        sqlx::query(
            "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(event_id)
        .bind(format!("bin_{i}"))
        .bind(format!("{i}-{}", i + 1))
        .bind(i)
        .bind(i as f64)
        .bind((i + 1) as f64)
        .execute(&pool)
        .await?;
    }

    let state = crate::lmsr_api::get_market_state(&pool, event_id).await?;
    assert_eq!(state["numeric_market_version"].as_i64(), Some(7));

    // Binary events report null.
    let binary_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('binary probe', NOW() + INTERVAL '7 days', 'binary') RETURNING id",
    )
    .fetch_one(&pool)
    .await?;
    let state = crate::lmsr_api::get_market_state(&pool, binary_id).await?;
    assert!(state["numeric_market_version"].is_null());
    Ok(())
}
```

- [ ] **Step 2: Run it, verify FAIL** (`as_i64()` returns `None` — field absent)

Same runner as Task 1 Step 3, with this test's filter.

- [ ] **Step 3: Implement**

In `get_market_state`'s first SQL (after the `total_trades` subselect, before `FROM events e`), add:

```sql
            (
                SELECT c.numeric_market_version
                FROM numeric_market_config c
                WHERE c.event_id = e.id
            ) AS numeric_market_version
```

and in the `json!` payload at the bottom (~line 2383):

```rust
"numeric_market_version": row.get::<Option<i64>, _>("numeric_market_version"),
```

- [ ] **Step 4: Re-run test — PASS. Full suite: `./scripts/test_prediction_engine.sh --full` — PASS.**

- [ ] **Step 5: Verify the backend proxy passes the field through**

Read the handler for `GET /events/:id/market` in `backend/src/routes/api.js` → `predictionsController.js`. If it forwards the engine JSON verbatim (expected), no change. If it reconstructs an allowlist of fields, add `numeric_market_version` to it and `docker restart intellacc_backend`.

- [ ] **Step 6: Commit**

```bash
git add prediction-engine/src/lmsr_api.rs prediction-engine/src/integration_tests.rs
git commit -m "feat(engine): expose numeric_market_version in market-state response"
```

(Include the backend file too if Step 5 required a change.)

---

### Task 3: Engine — install the tracing subscriber

`tracing::warn!` call sites (including the two operationally important ones in `resolution_sync.rs:250,390`) are silently dropped: no subscriber is ever installed in `main()`. `tracing-subscriber = { version = "0.3", features = ["env-filter"] }` is already in `Cargo.toml:28-29`.

This is infrastructure wiring with no unit-testable behavior — verification is build + observed log output (TDD exception, approved by plan).

**Files:**
- Modify: `prediction-engine/src/main.rs:112-117` (top of `main()`)
- Modify: `prediction-engine/src/resolution_sync.rs` (~lines 245-260 and ~385-400: remove the duplicate `println!` fallbacks and their "no subscriber installed" comments — keep the `tracing::warn!` calls)

- [ ] **Step 1: Add the subscriber init**

In `main()`, right after `dotenv::dotenv().ok();`:

```rust
tracing_subscriber::fmt()
    .with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    )
    .init();
```

- [ ] **Step 2: Remove the now-redundant `println!` duplicates in `resolution_sync.rs`**

Both no-match warn sites carry a `println!` twin plus a comment explaining the binary never installs a subscriber. Delete the `println!` lines and that comment; keep the `tracing::warn!` calls unchanged. Check `stress.rs:676` — its `tracing_subscriber::fmt::try_init()` uses `try_init` so it tolerates the global default now existing; leave it.

- [ ] **Step 3: Lib tests still green**

Run: `./scripts/test_prediction_engine.sh`
Expected: PASS.

- [ ] **Step 4: Rebuild and verify live log output**

```bash
cd /var/opt/docker/intellacc.com && docker compose up -d --build prediction-engine
sleep 5 && docker logs --since 2m intellacc_prediction_engine | head -30
```

Expected: startup lines now include `INFO`-level tracing-formatted output (timestamped), alongside the existing `println!` banner.

- [ ] **Step 5: Commit**

```bash
git add prediction-engine/src/main.rs prediction-engine/src/resolution_sync.rs
git commit -m "feat(engine): install tracing subscriber; drop println fallbacks in resolution sync"
```

---

### Task 4: Engine — generalize the post-resolution invariant to outcome tables

`verify_post_resolution_invariant_transaction` (`lmsr_api.rs:2788-2843`) only counts `user_shares` (binary legacy). Resolved numeric/MC events with stranded `user_outcome_shares` rows or non-zero `numeric_position_basis` would report `valid: true`. (Static analysis found NO 500-on-unresolved bug — the unresolved case explicitly returns `valid: true, "not applicable"`; keep that behavior and pin it with a test.)

**Files:**
- Modify: `prediction-engine/src/lmsr_api.rs:2788-2843`
- Modify: `prediction-engine/src/integration_tests.rs` (new test + two stand-in tables)

**Interfaces:**
- Produces: invariant JSON `{"valid": bool, ...}` now also reports `remaining_outcome_shares: i64` and `remaining_numeric_basis: i64` alongside the existing binary count.

- [ ] **Step 1: Add stand-in tables to `setup_test_database()`**

```rust
sqlx::query(
    r#"
    CREATE TABLE IF NOT EXISTS user_outcome_shares (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
        shares DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (shares >= 0.0),
        staked_ledger BIGINT NOT NULL DEFAULT 0 CHECK (staked_ledger >= 0),
        realized_pnl_ledger BIGINT NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, event_id, outcome_id)
    )
    "#,
)
.execute(pool)
.await?;

sqlx::query(
    r#"
    CREATE TABLE IF NOT EXISTS numeric_position_basis (
        user_id INTEGER NOT NULL REFERENCES users(id),
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        basis_ledger BIGINT NOT NULL DEFAULT 0 CHECK (basis_ledger >= 0),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, event_id)
    )
    "#,
)
.execute(pool)
.await?;
```

(Verify the live tables' primary keys with `\d` if unsure; these mirror production minus indexes.)

- [ ] **Step 2: Write the failing test**

```rust
#[tokio::test]
async fn test_post_resolution_invariant_covers_outcome_tables() -> Result<()> {
    let pool = setup_test_database().await?;
    // helper: seed a resolved MC-style event + one user (reuse the file's user helper if one exists)
    let user_id: i32 = sqlx::query_scalar(
        "INSERT INTO users (username, email, password_hash) VALUES ('inv_user', 'inv@test', 'x') RETURNING id",
    )
    .fetch_one(&pool)
    .await?;
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type, outcome, resolved_at)
         VALUES ('resolved mc', NOW() - INTERVAL '1 day', 'multiple_choice', 'resolved_choice_1', NOW()) RETURNING id",
    )
    .fetch_one(&pool)
    .await?;
    let outcome_id: i64 = sqlx::query_scalar(
        "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order) VALUES ($1, 'choice_1', 'Alpha', 0) RETURNING id",
    )
    .bind(event_id)
    .fetch_one(&pool)
    .await?;

    // Clean state: invariant holds.
    let result = crate::lmsr_api::verify_post_resolution_invariant(&pool, event_id).await?;
    assert_eq!(result["valid"].as_bool(), Some(true), "clean resolved event: {result}");

    // Stranded outcome shares: invariant must fail.
    sqlx::query(
        "INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares) VALUES ($1, $2, $3, 4.0)",
    )
    .bind(user_id).bind(event_id).bind(outcome_id)
    .execute(&pool)
    .await?;
    let result = crate::lmsr_api::verify_post_resolution_invariant(&pool, event_id).await?;
    assert_eq!(result["valid"].as_bool(), Some(false), "stranded outcome shares: {result}");
    sqlx::query("DELETE FROM user_outcome_shares WHERE event_id = $1").bind(event_id).execute(&pool).await?;

    // Non-zero numeric basis: invariant must fail.
    sqlx::query(
        "INSERT INTO numeric_position_basis (user_id, event_id, basis_ledger) VALUES ($1, $2, 5000000)",
    )
    .bind(user_id).bind(event_id)
    .execute(&pool)
    .await?;
    let result = crate::lmsr_api::verify_post_resolution_invariant(&pool, event_id).await?;
    assert_eq!(result["valid"].as_bool(), Some(false), "non-zero basis: {result}");

    // Unresolved event: still valid=true / not-applicable (regression pin).
    let open_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type) VALUES ('open', NOW() + INTERVAL '1 day', 'binary') RETURNING id",
    )
    .fetch_one(&pool)
    .await?;
    let result = crate::lmsr_api::verify_post_resolution_invariant(&pool, open_id).await?;
    assert_eq!(result["valid"].as_bool(), Some(true), "unresolved: {result}");
    Ok(())
}
```

(Adapt the `users` insert columns to the stand-in users table — read its DDL first. `verify_post_resolution_invariant` is the pool-level wrapper; if only the `_transaction` variant is public, call whichever the endpoint uses.)

- [ ] **Step 3: Run it — expect FAIL on the "stranded outcome shares" assertion (currently reports valid=true).**

- [ ] **Step 4: Implement**

In `verify_post_resolution_invariant_transaction`, after the existing `remaining_shares` count on `user_shares`, add:

```rust
let remaining_outcome_shares: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM user_outcome_shares WHERE event_id = $1 AND shares > 0",
)
.bind(event_id)
.fetch_one(tx.as_mut())
.await?;

let remaining_numeric_basis: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM numeric_position_basis WHERE event_id = $1 AND basis_ledger > 0",
)
.bind(event_id)
.fetch_one(tx.as_mut())
.await?;
```

and fold all three counts into the validity condition and the JSON payload (keep the existing field names, add `remaining_outcome_shares` and `remaining_numeric_basis`). Read the current JSON assembly and mirror its shape.

- [ ] **Step 5: Re-run test — PASS. Full suite `./scripts/test_prediction_engine.sh --full` — PASS.**

- [ ] **Step 6: Commit**

```bash
git add prediction-engine/src/lmsr_api.rs prediction-engine/src/integration_tests.rs
git commit -m "fix(engine): post-resolution invariant covers user_outcome_shares and numeric_position_basis"
```

---

### Task 5: Engine — batch settlement balance updates

`resolve_event_by_outcome_transaction` (`lmsr_api.rs:2102-2237`) issues one `UPDATE users` per (user, bin) row in `user_outcome_shares` (≈50/user for numeric markets) plus one per user for basis unstake. Batch both into a single `UPDATE … FROM UNNEST` and a single basis-zeroing statement, inside the same transaction, preserving the non-negative guards per row.

This is a **behavior-preserving refactor on a money path**: write the behavioral test against the CURRENT implementation first, watch it pass, then refactor and watch it stay green. One deliberate behavior change: today Loop 1 silently ignores a failed guard (`rows_affected == 0`); the batched version errors the whole transaction on any unapplied row — a settlement that can't fully apply must abort, not partially pay.

**Files:**
- Modify: `prediction-engine/src/db_adapter.rs` (new `update_user_balances_ledger_batch`)
- Modify: `prediction-engine/src/lmsr_api.rs:2102-2237`
- Modify: `prediction-engine/src/integration_tests.rs` (new test; stand-ins from Tasks 1/4 already present)

**Interfaces:**
- Consumes: stand-in tables from Task 1 (`event_outcome_states`) and Task 4 (`user_outcome_shares`, `numeric_position_basis`).
- Produces: `DbAdapter::update_user_balances_ledger_batch(tx, user_ids: &[i32], balance_deltas: &[i64], staked_deltas: &[i64]) -> Result<u64>`.

- [ ] **Step 1: Write the behavioral settlement test (must PASS against current code)**

```rust
#[tokio::test]
async fn test_numeric_settlement_pays_out_and_clears_positions() -> Result<()> {
    let pool = setup_test_database().await?;
    // Event with 4 bins [0,1) [1,2) [2,3) [3,4]; resolution value 2.5 -> bin_2 wins.
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('settle numeric', NOW() - INTERVAL '1 hour', 'numeric') RETURNING id",
    ).fetch_one(&pool).await?;
    sqlx::query(
        "INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric)
         VALUES ($1, 0, 4, 4, 886.0)",
    ).bind(event_id).execute(&pool).await?;
    let mut outcome_ids = Vec::new();
    for i in 0..4i32 {
        let oid: i64 = sqlx::query_scalar(
            "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        )
        .bind(event_id).bind(format!("bin_{i}")).bind(format!("{i}-{}", i + 1))
        .bind(i).bind(i as f64).bind((i + 1) as f64)
        .fetch_one(&pool).await?;
        outcome_ids.push(oid);
    }

    // Two users. u1 holds 3.0 shares of the winning bin + 2.0 of a losing bin,
    // basis 4_000_000 (4 RP). u2 holds 1.5 shares of a losing bin, basis 1_000_000.
    // Balances start at 100 RP; staked mirrors basis (numeric staking model:
    // user_outcome_shares.staked_ledger stays 0, stake lives in the basis table).
    let u1: i32 = sqlx::query_scalar(
        "INSERT INTO users (username, email, password_hash, rp_balance_ledger, rp_staked_ledger)
         VALUES ('settle_u1', 's1@test', 'x', 100000000, 4000000) RETURNING id",
    ).fetch_one(&pool).await?;
    let u2: i32 = sqlx::query_scalar(
        "INSERT INTO users (username, email, password_hash, rp_balance_ledger, rp_staked_ledger)
         VALUES ('settle_u2', 's2@test', 'x', 100000000, 1000000) RETURNING id",
    ).fetch_one(&pool).await?;
    for (uid, oid, shares) in [(u1, outcome_ids[2], 3.0f64), (u1, outcome_ids[0], 2.0), (u2, outcome_ids[1], 1.5)] {
        sqlx::query(
            "INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
             VALUES ($1, $2, $3, $4, 0)",
        ).bind(uid).bind(event_id).bind(oid).bind(shares).execute(&pool).await?;
    }
    sqlx::query("INSERT INTO numeric_position_basis (user_id, event_id, basis_ledger) VALUES ($1, $2, 4000000), ($3, $2, 1000000)")
        .bind(u1).bind(event_id).bind(u2).execute(&pool).await?;

    crate::lmsr_api::resolve_numeric_event(&pool, event_id, 2.5).await?;

    // u1: +3.0 shares * 1 RP payout = +3_000_000 balance; staked -4_000_000 -> 0.
    let (b1, s1): (i64, i64) = sqlx::query_as(
        "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1",
    ).bind(u1).fetch_one(&pool).await?;
    assert_eq!(b1, 103_000_000);
    assert_eq!(s1, 0);
    // u2: no payout; staked released.
    let (b2, s2): (i64, i64) = sqlx::query_as(
        "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1",
    ).bind(u2).fetch_one(&pool).await?;
    assert_eq!(b2, 100_000_000);
    assert_eq!(s2, 0);
    // Positions cleared.
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_outcome_shares WHERE event_id = $1")
        .bind(event_id).fetch_one(&pool).await?;
    assert_eq!(remaining, 0);
    let basis: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(basis_ledger), 0) FROM numeric_position_basis WHERE event_id = $1",
    ).bind(event_id).fetch_one(&pool).await?;
    assert_eq!(basis, 0);
    Ok(())
}
```

**IMPORTANT:** `resolve_event_by_outcome_transaction` may touch further tables (e.g. `event_outcome_states`, `events.resolution_outcome_id`, notification/log tables). Read the whole function FIRST and add stand-ins for anything the test DB lacks. If the expected payout numbers don't match the function's actual math (read it — payout may be shares × LEDGER_SCALE exactly as assumed here, or include staked release differently), fix the TEST's expectations to match observed current behavior, since this is a characterization test.

- [ ] **Step 2: Run it — must PASS against the current per-row implementation.** If it fails, the test's model of current behavior is wrong — fix the test, not the code, and note what you learned.

- [ ] **Step 3: Add the batch helper to `db_adapter.rs`**

```rust
/// Batched variant of update_user_balance_ledger: one UPDATE for many users.
/// The three slices are parallel arrays. Preserves the same per-row
/// non-negative guards; returns rows_affected so callers can detect
/// rows the guards rejected.
pub async fn update_user_balances_ledger_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_ids: &[i32],
    balance_deltas: &[i64],
    staked_deltas: &[i64],
) -> Result<u64> {
    if user_ids.is_empty() {
        return Ok(0);
    }
    let rows_affected = sqlx::query(
        "UPDATE users u SET
            rp_balance_ledger = u.rp_balance_ledger + t.balance_delta,
            rp_staked_ledger  = u.rp_staked_ledger  + t.staked_delta
         FROM UNNEST($1::int[], $2::bigint[], $3::bigint[])
              AS t(user_id, balance_delta, staked_delta)
         WHERE u.id = t.user_id
           AND (u.rp_balance_ledger + t.balance_delta) >= 0
           AND (u.rp_staked_ledger  + t.staked_delta) >= 0",
    )
    .bind(user_ids)
    .bind(balance_deltas)
    .bind(staked_deltas)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    Ok(rows_affected)
}
```

- [ ] **Step 4: Refactor the two settlement loops**

In `resolve_event_by_outcome_transaction`:
1. Keep the two `SELECT … FOR UPDATE` fetches unchanged.
2. Replace the per-row `update_user_balance_ledger` calls with a single aggregation pass:

```rust
use std::collections::BTreeMap;
// (user_id) -> (balance_delta, staked_delta), aggregated across bins and basis.
let mut deltas: BTreeMap<i32, (i64, i64)> = BTreeMap::new();
for row in &rows {
    let user_id: i32 = row.get("user_id");
    let row_outcome_id: i64 = row.get("outcome_id");
    let shares: f64 = row.get("shares");
    let staked_ledger: i64 = row.get("staked_ledger");
    let payout_shares = if row_outcome_id == outcome_id { shares } else { 0.0 };
    let payout_ledger = i64::try_from(to_ledger_units(payout_shares).map_err(|e| anyhow!(e))?)
        .map_err(|_| anyhow!("payout_ledger out of i64 range"))?;
    let entry = deltas.entry(user_id).or_insert((0, 0));
    entry.0 = entry.0.checked_add(payout_ledger).ok_or_else(|| anyhow!("balance delta overflow"))?;
    entry.1 = entry.1.checked_sub(staked_ledger).ok_or_else(|| anyhow!("staked delta overflow"))?;
}
for row in &numeric_positions {
    let user_id: i32 = row.get("user_id");
    let basis_ledger: i64 = row.get("basis_ledger");
    let entry = deltas.entry(user_id).or_insert((0, 0));
    entry.1 = entry.1.checked_sub(basis_ledger).ok_or_else(|| anyhow!("staked delta overflow"))?;
}
let user_ids: Vec<i32> = deltas.keys().copied().collect();
let balance_deltas: Vec<i64> = deltas.values().map(|d| d.0).collect();
let staked_deltas: Vec<i64> = deltas.values().map(|d| d.1).collect();
let affected =
    DbAdapter::update_user_balances_ledger_batch(tx, &user_ids, &balance_deltas, &staked_deltas).await?;
if affected != user_ids.len() as u64 {
    return Err(anyhow!(
        "settlement balance update applied to {} of {} users on event {} — aborting resolution",
        affected, user_ids.len(), event_id
    ));
}
```

3. Replace the per-row basis zeroing with:

```rust
sqlx::query(
    "UPDATE numeric_position_basis SET basis_ledger = 0, updated_at = NOW()
     WHERE event_id = $1 AND basis_ledger > 0",
)
.bind(event_id)
.execute(tx.as_mut())
.await?;
```

Keep everything else (share-row deletion, event update, ordering) untouched. `BTreeMap` (not HashMap) so the array order is deterministic.

- [ ] **Step 5: Re-run the settlement test — PASS unchanged. Full suite `./scripts/test_prediction_engine.sh --full` — PASS.**

- [ ] **Step 6: Commit**

```bash
git add prediction-engine/src/db_adapter.rs prediction-engine/src/lmsr_api.rs prediction-engine/src/integration_tests.rs
git commit -m "perf(engine): batch settlement balance updates into one UPDATE per resolution"
```

---

### Task 6: Frontend — hide the binary % header on numeric market detail

Numeric markets were seeded with `market_prob = 0.02`, so the detail header shows a meaningless "2.0%" and a 2%-filled probability bar above the distribution chart.

**Files:**
- Modify: `frontend-solid/src/components/predictions/MarketDetailView.jsx:170-186`
- Test: `tests/e2e/numeric-market.spec.js`

**Interfaces:**
- Consumes: existing `isNumeric` helper already defined at `MarketDetailView.jsx:15`.

- [ ] **Step 1: Write the failing E2E assertion**

In `tests/e2e/numeric-market.spec.js`, in the logged-out rendering test (the one asserting the distribution card renders), add after the existing card assertions:

```js
// Numeric markets must not show the meaningless binary % header.
await expect(page.locator('.market-detail-prob')).toHaveCount(0);
await expect(page.locator('.market-detail-header .event-prob-bar')).toHaveCount(0);
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `npx playwright test tests/e2e/numeric-market.spec.js`
Expected: FAIL — `.market-detail-prob` resolves to 1 element.

- [ ] **Step 3: Implement**

In `MarketDetailView.jsx`, wrap the prob span and the bar (NOT the title) in the header:

```jsx
<div class="market-detail-title-row">
  <h2 class="market-detail-title">{event().title}</h2>
  <Show when={!isNumeric(event())}>
    <span class="market-detail-prob">{formatProbability(event().market_prob)}</span>
  </Show>
</div>
<Show when={!isNumeric(event())}>
  <div class="event-prob-bar" aria-hidden="true">
    <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
  </div>
</Show>
```

- [ ] **Step 4: Run the whole spec — PASS (all numeric-market tests). Also run `npx playwright test tests/e2e/market-detail.spec.js` to confirm binary markets still show the %.**

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/components/predictions/MarketDetailView.jsx tests/e2e/numeric-market.spec.js
git commit -m "fix(numeric-markets): hide meaningless binary % header on numeric detail"
```

---

### Task 7: Frontend — MyPositions numeric meta line

Numeric positions render one `{label} ×{shares}` fragment per held bin in the collapsed row meta (up to 50 fragments), plus the same meaningless binary %.

**Files:**
- Modify: `frontend-solid/src/components/predictions/MyPositions.jsx` (positionGroups memo ~lines 91-129; row render ~lines 236-258)
- Test: `tests/e2e/my-positions-section.spec.js`

**Interfaces:**
- Consumes: local `isNumeric` helper already at `MyPositions.jsx:38`; API rows with `event_type`, `outcome_label`, `outcome_shares`.
- Produces: numeric rows show exactly `Distribution · {bins} bins · {shares} sh` (shares with `toFixed(1)`), no `%`, no prob bar.

- [ ] **Step 1: Write the failing E2E test**

Add to `tests/e2e/my-positions-section.spec.js` (reuse the file's `psql`, `stamp`, login flow; seed with `staked_ledger` 0 like the existing open-event seed so the afterAll refund stays a no-op):

```js
test('numeric position shows one distribution meta line, not per-bin labels', async ({ page }) => {
  const title = `E2E pos numeric ${stamp}`;
  const evId = Number(psql(
    `INSERT INTO events (title, closing_date, event_type)
     VALUES ('${title}', NOW() + INTERVAL '7 days', 'numeric') RETURNING id`
  ));
  eventIds.numeric = evId;
  psql(`INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric)
        VALUES (${evId}, 0, 4, 4, 886.0)`);
  const binIds = [];
  for (let i = 0; i < 4; i++) {
    binIds.push(Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
       VALUES (${evId}, 'bin_${i}', '${i}-${i + 1}', ${i}, ${i}, ${i + 1}) RETURNING id`
    )));
  }
  psql(`INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
        VALUES (${userId}, ${evId}, ${binIds[1]}, 2.0, 0), (${userId}, ${evId}, ${binIds[2]}, 4.0, 0)`);

  await login(page);
  const row = page.locator('.event-list-item', { hasText: title });
  await expect(row).toBeVisible();
  await expect(row.locator('.event-category')).toHaveText('Distribution · 2 bins · 6.0 sh');
  await expect(row.locator('.event-prob')).toHaveCount(0);
  await expect(row.locator('.event-prob-bar')).toHaveCount(0);
});
```

(Adapt selectors/login helper names to what the spec actually uses — read it first. Register `eventIds.numeric` so the existing afterAll cleanup deletes it.)

- [ ] **Step 2: Run it, verify FAIL** (meta shows `1-2 ×2.0 · 2-3 ×4.0` and a %).

Run: `npx playwright test tests/e2e/my-positions-section.spec.js`

- [ ] **Step 3: Implement**

In the `positionGroups` memo: initialize `numericBins: 0, numericShares: 0` on each new group; then branch the outcome push:

```js
if (group.event.event_type === 'numeric') {
  if (row.outcome_label && Number(row.outcome_shares) > 0) {
    group.numericBins += 1;
    group.numericShares += Number(row.outcome_shares);
  }
} else {
  if (row.outcome_label && Number(row.outcome_shares) > 0) {
    group.outcomes.push({ label: row.outcome_label, shares: Number(row.outcome_shares) });
  }
  if (Number(row.yes_shares) > 0) group.outcomes.push({ label: 'YES', shares: Number(row.yes_shares) });
  if (Number(row.no_shares) > 0) group.outcomes.push({ label: 'NO', shares: Number(row.no_shares) });
}
```

In the row render, guard the prob span and bar with `<Show when={!isNumeric(group().event)}>` (same pattern as Task 6) and replace the outcomes meta span with:

```jsx
<Show
  when={!isNumeric(group().event)}
  fallback={
    <Show when={group().numericBins > 0}>
      <span class="event-category">
        {`Distribution · ${group().numericBins} bins · ${group().numericShares.toFixed(1)} sh`}
      </span>
    </Show>
  }
>
  <Show when={group().outcomes.length > 0}>
    <span class="event-category">
      {group().outcomes.map((o) => `${o.label} ×${o.shares.toFixed(1)}`).join(' · ')}
    </span>
  </Show>
</Show>
```

- [ ] **Step 4: Run the whole spec — PASS (including the two pre-existing tests).**

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/components/predictions/MyPositions.jsx tests/e2e/my-positions-section.spec.js
git commit -m "fix(numeric-markets): MyPositions shows one distribution meta line instead of per-bin labels"
```

---

### Task 8: Frontend — RP balance header refreshes after trades

`RPBalance.jsx` (the predictions/analytics header widget) never listens for the `rp-balance-refresh` CustomEvent; the trading cards never dispatch it. (The terminal skin's `TerminalRPBalance.jsx:29-32` already has the listener — copy that pattern. `socket.js:17-27` dispatches it debounced on websocket `marketUpdate`, but direct dispatch on trade success gives immediate feedback and works without a socket.)

**Files:**
- Modify: `frontend-solid/src/components/predictions/RPBalance.jsx` (add listener)
- Modify: `frontend-solid/src/components/predictions/DistributionMarketCard.jsx` (trade+sell success paths, ~lines 389-396, 441-446)
- Modify: `frontend-solid/src/components/predictions/MarketEventCard.jsx` (`handleStake` ~244, `executeSell` ~301, `handleFullExit` ~362)
- Modify: `frontend-solid/src/components/predictions/OutcomeMarketCard.jsx` (buy/sell success paths — locate the equivalent `await onTrade()?.` sites)
- Test: `tests/e2e/numeric-market.spec.js`

- [ ] **Step 1: Write the failing E2E assertion**

In the logged-in trade test of `numeric-market.spec.js`, before executing the trade, read the header balance; after the trade completes (existing success assertion), expect it to have changed without any reload:

```js
const rpText = page.locator('.rp-balance-value').first(); // adapt to RPBalance's real class — read the component
const before = await rpText.textContent();
// ... existing trade steps ...
await expect(rpText).not.toHaveText(before, { timeout: 5000 });
```

- [ ] **Step 2: Run it, verify FAIL** (balance text stays stale until manual refresh).

- [ ] **Step 3: Implement**

`RPBalance.jsx` — inside the existing `onMount`:

```js
window.addEventListener('rp-balance-refresh', loadBalance);
```

and in the existing `onCleanup`:

```js
window.removeEventListener('rp-balance-refresh', loadBalance);
```

Each card, immediately after its success message / before the `await loadMarketState()`-style refreshes, add one line:

```js
window.dispatchEvent(new CustomEvent('rp-balance-refresh'));
```

Sites: DistributionMarketCard `handleTrade` + `handleSell` success paths; MarketEventCard `handleStake`, `executeSell`, `handleFullExit` success paths; OutcomeMarketCard buy + sell success paths.

- [ ] **Step 4: Run `npx playwright test tests/e2e/numeric-market.spec.js` — PASS. Sanity: `npx playwright test tests/e2e/market-detail.spec.js tests/e2e/multi-outcome-trading.spec.js` — PASS (their trades now also dispatch; nothing should assert staleness).**

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/components/predictions/RPBalance.jsx frontend-solid/src/components/predictions/DistributionMarketCard.jsx frontend-solid/src/components/predictions/MarketEventCard.jsx frontend-solid/src/components/predictions/OutcomeMarketCard.jsx tests/e2e/numeric-market.spec.js
git commit -m "fix(predictions): refresh RP balance header immediately after trades"
```

---

### Task 9: Frontend — decouple Sell from the budget quote + friendlier span-clamp copy

Clearing the Trade-size input nulls `quote()`, which disables the Sell button (`DistributionMarketCard.jsx:688-695` gates on `!quote()`), even though selling only needs a `market_version`. Task 2 exposed `numeric_market_version` in the market-state response.

**Files:**
- Modify: `frontend-solid/src/components/predictions/DistributionMarketCard.jsx`
- Test: `tests/e2e/numeric-market.spec.js`

**Interfaces:**
- Consumes: `numeric_market_version` field from Task 2 (via existing `getMarketState()` call in `loadMarketState`).

- [ ] **Step 1: Write the failing E2E assertion**

In the sell test of `numeric-market.spec.js`, after the trade and before clicking Sell, clear the budget input and assert Sell stays enabled:

```js
await page.locator('.distribution-card-budget-input').fill('');
const sellButton = page.getByRole('button', { name: /sell all/i });
await expect(sellButton).toBeEnabled({ timeout: 5000 });
// ... existing sell click + assertions continue from here ...
```

- [ ] **Step 2: Run it, verify FAIL** (button disables once the quote bails to null).

- [ ] **Step 3: Implement**

In `DistributionMarketCard.jsx`:

1. New signal near the other market signals: `const [marketVersion, setMarketVersion] = createSignal(null);`
2. In `loadMarketState`, after `setBins(rows)`: `setMarketVersion(state?.numeric_market_version ?? null);` (and `setMarketVersion(null)` on the unconfigured/error paths).
3. Version accessor: `const sellVersion = () => quote()?.market_version ?? marketVersion();`
4. In `handleSell`, replace the `activeQuote.market_version` dependency: read `const version = sellVersion(); if (version == null) return;` and pass `marketVersion: version` (keep everything else, including the OCC 409 retry handling, unchanged).
5. Sell button disabled expression becomes:

```jsx
disabled={!!busyAction() || !isOpen() || totalShares() <= 0 || sellVersion() == null}
```

6. Span-clamp copy remap — add a small helper near the error helpers:

```js
const friendlyTradeError = (message) => {
  if (typeof message === 'string' && message.includes('too extreme or target too concentrated')) {
    return "Your target is too concentrated for this market's liquidity — widen your P10–P90 range or reduce the trade size.";
  }
  return message;
};
```

and wrap the message in the `fetchQuote` catch (`setQuoteError(friendlyTradeError(err?.message) || 'Failed to fetch quote.')`) and the `handleTrade` catch (`setError(friendlyTradeError(err?.message) || 'Failed to place trade.')`).

- [ ] **Step 4: Run the whole numeric spec — PASS (trade, sell, logged-out, MC dispatch tests all green).**

Run: `npx playwright test tests/e2e/numeric-market.spec.js`

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/components/predictions/DistributionMarketCard.jsx tests/e2e/numeric-market.spec.js
git commit -m "fix(numeric-markets): Sell no longer depends on the budget quote; friendlier span-clamp copy"
```

---

### Task 10: E2E — stop leaking staked RP on fixture deletion; reconcile test users

Deleting fixture events cascades share rows but never unwinds `users.rp_staked_ledger`. `market-detail.spec.js` trades as shared user1 and bare-deletes its events — user1 has accumulated a 900 RP staked orphan (zero backing positions; verified 2026-07-15). `multi-outcome-trading.spec.js` and `my-positions-section.spec.js` carry inline refund SQL (covering only `user_outcome_shares`); `reset-test-users.sh` never reconciles RP.

**Files:**
- Create: `tests/e2e/helpers/stakeRefund.js`
- Modify: `tests/e2e/market-detail.spec.js` (afterAll), `tests/e2e/multi-outcome-trading.spec.js` (swap inline SQL), `tests/e2e/my-positions-section.spec.js` (swap inline SQL), `tests/e2e/numeric-market.spec.js` (afterAll, belt-and-braces), `tests/e2e/community-group-markets.spec.js` + `tests/e2e/terminal-admin.spec.js` (afterAll, if they delete events shared users traded on — read them and decide)
- Modify: `tests/e2e/reset-test-users.sh`

**Interfaces:**
- Produces: `refundEventStakes(psql, ids)` — `psql` is the spec's own SQL runner (a `(sql: string) => string` function), `ids` a comma-joined string of event ids (or empty).

- [ ] **Step 1: Reproduce the leak (RED)**

```bash
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -tAc \
  "SELECT rp_staked_ledger FROM users WHERE email='user1@example.com'"
npx playwright test tests/e2e/market-detail.spec.js
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -tAc \
  "SELECT rp_staked_ledger FROM users WHERE email='user1@example.com'"
```

Expected: the second value is HIGHER than the first (the trade test's stake leaked). Record both numbers in the task report.

- [ ] **Step 2: Create the shared helper**

`tests/e2e/helpers/stakeRefund.js`:

```js
// Refund staked RP still held against a set of events BEFORE deleting the
// event rows. Event deletion cascades user_shares / user_outcome_shares /
// numeric_position_basis but does NOT unwind users.rp_staked_ledger, so a
// bare DELETE permanently leaks staked RP on shared test accounts.
// `psql` is the calling spec's own SQL runner; `ids` a comma-joined id list.
const refundEventStakes = (psql, ids) => {
  if (!ids) return;
  psql(`UPDATE users u
        SET rp_balance_ledger = rp_balance_ledger + s.total,
            rp_staked_ledger = rp_staked_ledger - s.total
        FROM (SELECT user_id, SUM(staked_yes_ledger + staked_no_ledger) AS total
              FROM user_shares WHERE event_id IN (${ids}) GROUP BY user_id) s
        WHERE s.user_id = u.id AND s.total > 0`);
  psql(`UPDATE users u
        SET rp_balance_ledger = rp_balance_ledger + s.total,
            rp_staked_ledger = rp_staked_ledger - s.total
        FROM (SELECT user_id, SUM(staked_ledger) AS total
              FROM user_outcome_shares WHERE event_id IN (${ids}) GROUP BY user_id) s
        WHERE s.user_id = u.id AND s.total > 0`);
  psql(`UPDATE users u
        SET rp_balance_ledger = rp_balance_ledger + b.total,
            rp_staked_ledger = rp_staked_ledger - b.total
        FROM (SELECT user_id, SUM(basis_ledger) AS total
              FROM numeric_position_basis WHERE event_id IN (${ids}) GROUP BY user_id) b
        WHERE b.user_id = u.id AND b.total > 0`);
};

module.exports = { refundEventStakes };
```

- [ ] **Step 3: Wire it into the specs**

- `market-detail.spec.js` afterAll — before the `DELETE FROM market_updates` line: `refundEventStakes(psql, ids);`
- `multi-outcome-trading.spec.js` + `my-positions-section.spec.js` — replace their inline refund UPDATE blocks with `refundEventStakes(psql, String(eventId))` / `refundEventStakes(psql, ids)` (the helper is a superset: it adds `user_shares` and `numeric_position_basis` coverage).
- `numeric-market.spec.js` afterAll — call it before the event deletes (its user is disposable, but if the spec ever switches to a shared account this keeps it safe).
- Read `community-group-markets.spec.js` and `terminal-admin.spec.js`: if their deleted events can carry stakes from shared users, add the call; if they never trade, leave them and say so in the report.
- Each spec imports: `const { refundEventStakes } = require('./helpers/stakeRefund');`

- [ ] **Step 4: Verify the leak is gone (GREEN)**

Repeat Step 1's three commands. Expected: `rp_staked_ledger` identical before and after the spec run. Then run the other two touched trading specs once each to confirm they still pass with the helper swapped in:

```bash
npx playwright test tests/e2e/multi-outcome-trading.spec.js tests/e2e/my-positions-section.spec.js
```

- [ ] **Step 5: Add reconciliation to `reset-test-users.sh` and heal user1**

Append inside the existing psql heredoc, after the `tmp_test_user_ids` creation (release orphaned stake back to balance; only ever shrink staked, never grow it):

```sql
-- Reconcile rp_staked_ledger against actual open positions: past spec runs
-- deleted events without refunding, leaving orphaned staked RP.
UPDATE users u
SET
  rp_balance_ledger = rp_balance_ledger + (u.rp_staked_ledger - expected.total),
  rp_staked_ledger = expected.total
FROM (
  SELECT t.id,
    COALESCE((SELECT SUM(staked_yes_ledger + staked_no_ledger) FROM user_shares s WHERE s.user_id = t.id), 0)
    + COALESCE((SELECT SUM(staked_ledger) FROM user_outcome_shares o WHERE o.user_id = t.id), 0)
    + COALESCE((SELECT SUM(basis_ledger) FROM numeric_position_basis b WHERE b.user_id = t.id), 0) AS total
  FROM tmp_test_user_ids t
) expected
WHERE u.id = expected.id AND u.rp_staked_ledger > expected.total;
```

Then run it and verify:

```bash
./tests/e2e/reset-test-users.sh
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -tAc \
  "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE email='user1@example.com'"
```

Expected: `rp_staked_ledger` is now `0` and `rp_balance_ledger` grew by exactly the released orphan (was ~80_100_001 + 900_000_000 as of plan time; other sessions may shift the numbers — the invariant is staked==0 and balance grew by the released amount).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/helpers/stakeRefund.js tests/e2e/market-detail.spec.js tests/e2e/multi-outcome-trading.spec.js tests/e2e/my-positions-section.spec.js tests/e2e/numeric-market.spec.js tests/e2e/reset-test-users.sh
git commit -m "test(e2e): refund staked RP before fixture event deletion; reconcile test users on reset"
```

(Add the community/terminal specs to the list if Step 3 touched them.)

---

### Task 11: Ops — numeric-resolution runbook + hide the two unresolvable MC events

Numeric (and label-mismatched MC) markets cannot auto-resolve (Metaculus resolutions are null at our token tier; MC label match fails safe). Closed-unresolved markets freeze holders' RP until an admin resolves. Currently 8 closed-unresolved numeric markets exist (all zero positions). Events 1324 and 3222 (Manifold-sourced MC) carry stale seeded labels, are past close with zero positions, and can never label-match — hide them.

**Files:**
- Create: `docs/ops/numeric-market-resolution.md`
- One-off SQL against production (hide 1324/3222)

- [ ] **Step 1: Write the runbook**

`docs/ops/numeric-market-resolution.md` — content (verify each command against the code before writing; the API shapes below were confirmed 2026-07-15):

````markdown
# Runbook: resolving numeric & stuck multiple-choice markets

Numeric markets NEVER auto-resolve: Metaculus hides `question.resolution`
at our API token tier, so `resolution_sync` has nothing to read. MC markets
auto-resolve by label match but fail safe (leave `outcome IS NULL`) on any
mismatch/ambiguity. Sells lock at `closing_date` — a closed, unresolved
market freezes every holder's staked RP until an admin resolves it.
**Run the detection query weekly** (or after any Metaculus import sync).

## 1. Detect

```sql
-- closed, unresolved numeric + MC markets, with open-position counts
SELECT e.id, e.event_type, LEFT(e.title, 60) AS title, e.closing_date,
       s.source, s.external_url,
       (SELECT COUNT(*) FROM user_outcome_shares u
         WHERE u.event_id = e.id AND u.shares > 0)  AS open_positions,
       (SELECT COALESCE(SUM(b.basis_ledger), 0) FROM numeric_position_basis b
         WHERE b.event_id = e.id)                    AS frozen_basis_ledger
FROM events e
LEFT JOIN event_external_sources s ON s.event_id = e.id
WHERE e.closing_date < NOW()
  AND e.resolved_at IS NULL
  AND e.outcome IS NULL
  AND e.event_type IN ('numeric', 'multiple_choice')
  AND e.hidden_at IS NULL
ORDER BY frozen_basis_ledger DESC, e.closing_date;
```

Priority: anything with `open_positions > 0` or `frozen_basis_ledger > 0`.

## 2. Find the true outcome

Open `external_url` (Metaculus/Manifold) and read the resolved value there.

## 3. Resolve

Preferred — through the backend (admin JWT; logs, idempotency guard):

```bash
# numeric: pass the resolved numerical value; engine picks the winning bin
curl -X PATCH https://intellacc.com/api/events/<EVENT_ID> \
  -H "Authorization: Bearer <ADMIN_JWT>" -H "Content-Type: application/json" \
  -d '{"numerical_outcome": <VALUE>}'

# multiple-choice: resolve by outcome id (SELECT id, label FROM event_outcomes WHERE event_id = <EVENT_ID>)
curl -X PATCH https://intellacc.com/api/events/<EVENT_ID> \
  -H "Authorization: Bearer <ADMIN_JWT>" -H "Content-Type: application/json" \
  -d '{"outcome_id": <OUTCOME_ID>}'
```

Fallback — engine direct from the host (shared secret from `prediction-engine/.env`):

```bash
docker exec intellacc_backend node -e "
fetch('http://prediction-engine:3001/events/<EVENT_ID>/market-resolve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json',
             'x-engine-token': process.env.PREDICTION_ENGINE_AUTH_TOKEN },
  body: JSON.stringify({ numerical_outcome: <VALUE> })
}).then(r => r.json()).then(j => console.log(JSON.stringify(j)))"
```

## 4. Verify settlement

```bash
# invariant check (expects {"valid": true})
docker exec intellacc_backend node -e "
fetch('http://prediction-engine:3001/lmsr/verify-post-resolution', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json',
             'x-engine-token': process.env.PREDICTION_ENGINE_AUTH_TOKEN },
  body: JSON.stringify({ event_id: <EVENT_ID> })
}).then(r => r.json()).then(j => console.log(JSON.stringify(j)))"
```

## 5. Junk disposal

A closed market that can never resolve (dead source, stale labels) AND has
zero open positions and zero basis can be hidden instead:

```sql
UPDATE events SET hidden_at = NOW(), hidden_reason = '<why>'
WHERE id = <EVENT_ID>
  AND NOT EXISTS (SELECT 1 FROM user_outcome_shares u WHERE u.event_id = events.id AND u.shares > 0)
  AND NOT EXISTS (SELECT 1 FROM numeric_position_basis b WHERE b.event_id = events.id AND b.basis_ledger > 0);
```

NEVER hide a market with open positions — resolve it (or escalate) instead.
````

- [ ] **Step 2: Execute the junk disposal for 1324 and 3222**

```bash
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "
UPDATE events SET hidden_at = NOW(),
       hidden_reason = 'ops: stale seeded MC labels, source labels diverged, unresolvable by label match; zero positions (runbook 2026-07-15)'
WHERE id IN (1324, 3222)
  AND NOT EXISTS (SELECT 1 FROM user_outcome_shares u WHERE u.event_id = events.id AND u.shares > 0)
  AND NOT EXISTS (SELECT 1 FROM numeric_position_basis b WHERE b.event_id = events.id AND b.basis_ledger > 0);"
```

Expected: `UPDATE 2`. Then verify the detection query from the runbook no longer lists them.

- [ ] **Step 3: Run the detection query once and paste its current output into the task report** (expected: the 8 zero-position numeric markets remain, now documented as known/no-freeze).

- [ ] **Step 4: Commit**

```bash
git add docs/ops/numeric-market-resolution.md
git commit -m "docs(ops): runbook for resolving numeric/stuck-MC markets; hide two unresolvable MC events"
```

---

## Final gates (after all tasks)

- [ ] Engine: `./scripts/test_prediction_engine.sh --full` — all green.
- [ ] Engine deploy: `docker compose up -d --build prediction-engine` (if not already rebuilt in Task 3).
- [ ] Backend: `docker exec intellacc_backend npm test` (expect the 2 pre-existing failing suites, nothing new) and `docker restart intellacc_backend` if any backend file changed.
- [ ] E2E sweep (against solid-local): `npx playwright test tests/e2e/numeric-market.spec.js tests/e2e/market-detail.spec.js tests/e2e/my-positions-section.spec.js tests/e2e/multi-outcome-trading.spec.js` — run twice; flag any flake.
- [ ] Frontend deploy: `docker restart intellacc_frontend_solid` (~2 min outage; do it once, at the end). Verify at https://intellacc.de: numeric detail (e.g. /#predictions/1462) shows no % header, RP header updates after a small disposable-user trade, Sell stays enabled with empty budget.
- [ ] Push to master, then `gh run watch` both workflows ("CI" and "Prediction Engine Tests") to green.
