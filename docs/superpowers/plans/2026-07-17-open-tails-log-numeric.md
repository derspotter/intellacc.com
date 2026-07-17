# Open-Tail + Log-Scaled Numeric Markets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make log-scaled (`zero_point`) and open-bounded Metaculus numeric questions seedable, tradeable, and resolvable — covering the ~81% of live numeric questions the 50-bin linear LMSR cannot seed today.

**Architecture:** All internal math moves to Metaculus's internal coordinate t ∈ [0,1] ("transform-space binning"): a new `NumericTransform` maps nominal ↔ t with the exact Metaculus formulas, the seeder generates 50 inbound bins equal-width in t (plus up to two tail outcomes marked by a new `event_outcomes.bucket_kind` column), resolution routes out-of-range values to tails, and the frontend fits the split-normal and renders the chart in t-space with edge bars for tails. Linear markets are the identity case — one unified code path; the LMSR core, settlement, invariant, and OCC layers change not at all.

**Tech Stack:** Rust (Axum/sqlx, Docker-only builds), PostgreSQL migration, SolidJS + hand-rolled SVG, node:test for FE math, Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-07-17-open-tails-log-numeric-design.md` — binding. Read its "Resolution semantics" table and "The exact Metaculus transform" section before Tasks 2 and 4.

## Global Constraints

- **Prod box**: this repo runs production. Never `cargo` on the host — engine builds/tests run in Docker only. Engine test command: `cd prediction-engine && CARGO_TEST_ARGS='--bin prediction_engine <filter> -- --nocapture' docker compose -f docker-compose.test.yml run --rm prediction-engine-tests`. Full suite: `./scripts/test_prediction_engine.sh --full` from repo root.
- Verify UI at https://intellacc.de, NEVER localhost:4174 (that's the solid-local dev container). The solid-local dev stack MUST use `-p solid-local`.
- **Transform formulas verbatim** (Metaculus `utils/the_math/formulas.py`), with `d = (range_max − zero_point)/(range_min − zero_point)`:
  - nominal→t (zero_point set): `t = (ln((x − range_min)·(d − 1) + (range_max − range_min)) − ln(range_max − range_min)) / ln(d)`
  - t→nominal (zero_point set): `x = range_min + (range_max − range_min)·(d^t − 1)/(d − 1)`
  - zero_point null: plain linear normalize/denormalize.
- **Exact values**: tail outcome_keys `tail_low` / `tail_high`; `bucket_kind` values `'inbound' | 'lower_tail' | 'upper_tail'`; tail labels `"< {range_min}"` / `"> {range_max}"` (formatted by `format_bin_number`, unit-suffixed like bin labels); tails sort_order 50 then 51 (upper tail gets 50 if there is no lower tail); `binning_version = 2` for all newly seeded markets; `numeric_market_config.bin_count` stays **50 = inbound only**; `b_numeric = NUMERIC_MAX_SUBSIDY_RP / ln(outcome_count)` where `outcome_count = 50 + number_of_tails`; initial prob and `events.market_prob` = `1/outcome_count`.
- **Resolution semantics** (spec table): `x < range_min` → lower tail (else no-match); `x == range_min` → first inbound bin; interior → `[lower, upper)` scan with last inbound bin closed on upper; `x == range_max` → last inbound bin; `x > range_max` → upper tail (else no-match). Open upper tail means `X > max`, not `≥`.
- `TARGET_MASS_FLOOR = 1e-6` must stay identical in `lmsr_multi_core.rs` and `distributionMath.js`.
- FE unit tests run with `cd frontend-solid && node --test src/utils/distributionMath.test.js` (package is ESM, node:test works — verified with `src/lib/feedRanking.test.js`).
- Commit after every task. Working tree must be green (engine lib tests / touched FE tests) at every commit.
- Engine integration tests use the **stand-in schema** in `integration_tests.rs::setup_test_database()` — every new column an engine query touches must be added there or CI fails on the missing column.

---

### Task 1: `bucket_kind` migration + engine test-schema stand-in

**Files:**
- Create: `backend/migrations/20260717_event_outcomes_bucket_kind.sql`
- Modify: `prediction-engine/src/integration_tests.rs:281-290` (event_outcomes stand-in)

**Interfaces:**
- Produces: `event_outcomes.bucket_kind TEXT NOT NULL DEFAULT 'inbound'` with CHECK constraint — every later task reads/writes it.

- [ ] **Step 1: Write the migration**

```sql
-- backend/migrations/20260717_event_outcomes_bucket_kind.sql
-- Tail outcomes for open-bounded numeric markets (spec 2026-07-17):
-- 'inbound' = a regular bin, 'lower_tail' = X < range_min, 'upper_tail' = X > range_max.
ALTER TABLE event_outcomes
  ADD COLUMN IF NOT EXISTS bucket_kind TEXT NOT NULL DEFAULT 'inbound';

ALTER TABLE event_outcomes
  DROP CONSTRAINT IF EXISTS event_outcomes_bucket_kind_check;
ALTER TABLE event_outcomes
  ADD CONSTRAINT event_outcomes_bucket_kind_check
  CHECK (bucket_kind IN ('inbound', 'lower_tail', 'upper_tail'));
```

- [ ] **Step 2: Update the test-schema stand-in**

In `integration_tests.rs`, the `CREATE TABLE IF NOT EXISTS event_outcomes` block (line ~281) gains one line after `upper_bound DOUBLE PRECISION,`:

```sql
            bucket_kind TEXT NOT NULL DEFAULT 'inbound',
```

- [ ] **Step 3: Apply the migration to prod and verify**

```bash
docker restart intellacc_backend   # migrations auto-run on start
sleep 15
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "\d event_outcomes" | grep bucket_kind
```
Expected: `bucket_kind | text | not null | 'inbound'::text`

- [ ] **Step 4: Run one engine integration test to prove the stand-in compiles**

```bash
cd prediction-engine && CARGO_TEST_ARGS='--bin prediction_engine test_post_resolution_invariant -- --nocapture' docker compose -f docker-compose.test.yml run --rm prediction-engine-tests
```
Expected: PASS (the stand-in change is exercised by table creation).

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/20260717_event_outcomes_bucket_kind.sql prediction-engine/src/integration_tests.rs
git commit -m "feat(schema): event_outcomes.bucket_kind for numeric tail outcomes"
```

---

### Task 2: `NumericTransform` module (pure Rust, TDD unit tests)

**Files:**
- Create: `prediction-engine/src/numeric_transform.rs`
- Modify: `prediction-engine/src/lib.rs` (add `pub mod numeric_transform;` after line 12), `prediction-engine/src/main.rs` (add `mod numeric_transform;` after line 31)

**Interfaces:**
- Produces (used by Tasks 3, 4, 5):

```rust
pub struct NumericTransform { pub range_min: f64, pub range_max: f64, pub zero_point: Option<f64> }
impl NumericTransform {
    pub fn validate(&self) -> anyhow::Result<()>;
    pub fn to_internal(&self, x: f64) -> f64;   // nominal -> t
    pub fn to_nominal(&self, t: f64) -> f64;    // t -> nominal
    pub fn bin_edges_nominal(&self, bin_count: usize) -> Vec<(f64, f64)>; // exact endpoints
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BucketKind { Inbound, LowerTail, UpperTail }
impl BucketKind { pub fn parse(s: &str) -> Self; pub fn as_str(&self) -> &'static str; }
```

- [ ] **Step 1: Write the failing tests** (in `numeric_transform.rs`'s own `#[cfg(test)] mod tests`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn log_tf() -> NumericTransform {
        // Metaculus-style pure log question: zero_point 0, range 1..10000.
        // With these params to_nominal(t) == 10^(4t) exactly (algebraic identity).
        NumericTransform { range_min: 1.0, range_max: 10000.0, zero_point: Some(0.0) }
    }
    fn lin_tf() -> NumericTransform {
        NumericTransform { range_min: 0.0, range_max: 4.0, zero_point: None }
    }

    #[test]
    fn linear_maps_are_plain_normalization() {
        let tf = lin_tf();
        assert!((tf.to_internal(1.0) - 0.25).abs() < 1e-12);
        assert!((tf.to_nominal(0.25) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn log_transform_matches_metaculus_formula() {
        let tf = log_tf();
        for (t, x) in [(0.0, 1.0), (0.25, 10.0), (0.5, 100.0), (0.75, 1000.0), (1.0, 10000.0)] {
            assert!((tf.to_nominal(t) - x).abs() < 1e-6, "to_nominal({t}) = {}", tf.to_nominal(t));
            assert!((tf.to_internal(x) - t).abs() < 1e-9, "to_internal({x}) = {}", tf.to_internal(x));
        }
    }

    #[test]
    fn round_trip_is_stable() {
        for tf in [log_tf(), lin_tf()] {
            for i in 0..=100 {
                let t = i as f64 / 100.0;
                assert!((tf.to_internal(tf.to_nominal(t)) - t).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn bin_edges_are_monotone_contiguous_and_endpoint_exact() {
        for tf in [log_tf(), lin_tf()] {
            let edges = tf.bin_edges_nominal(50);
            assert_eq!(edges.len(), 50);
            assert_eq!(edges[0].0, tf.range_min);           // exact, not approx
            assert_eq!(edges[49].1, tf.range_max);          // exact, not approx
            for i in 0..50 {
                assert!(edges[i].1 > edges[i].0);
                if i > 0 { assert_eq!(edges[i].0, edges[i - 1].1); } // contiguous
            }
        }
    }

    #[test]
    fn linear_edges_match_existing_linear_bins() {
        let tf = lin_tf();
        let ours = tf.bin_edges_nominal(4);
        let theirs = crate::lmsr_multi_core::linear_bins(0.0, 4.0, 4, None);
        for (a, b) in ours.iter().zip(theirs.iter()) {
            assert!((a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9);
        }
    }

    #[test]
    fn validate_rejects_degenerate_shapes() {
        // zero_point inside the range -> d < 0
        assert!(NumericTransform { range_min: 0.0, range_max: 10.0, zero_point: Some(5.0) }.validate().is_err());
        // zero_point == range_min -> division by zero
        assert!(NumericTransform { range_min: 1.0, range_max: 10.0, zero_point: Some(1.0) }.validate().is_err());
        // inverted range
        assert!(NumericTransform { range_min: 5.0, range_max: 1.0, zero_point: None }.validate().is_err());
        // non-finite
        assert!(NumericTransform { range_min: f64::NAN, range_max: 1.0, zero_point: None }.validate().is_err());
        // healthy shapes pass
        assert!(log_tf().validate().is_ok());
        assert!(lin_tf().validate().is_ok());
    }

    #[test]
    fn bucket_kind_parses_and_roundtrips() {
        assert_eq!(BucketKind::parse("lower_tail"), BucketKind::LowerTail);
        assert_eq!(BucketKind::parse("upper_tail"), BucketKind::UpperTail);
        assert_eq!(BucketKind::parse("inbound"), BucketKind::Inbound);
        assert_eq!(BucketKind::parse("anything-else"), BucketKind::Inbound);
        assert_eq!(BucketKind::LowerTail.as_str(), "lower_tail");
    }
}
```

- [ ] **Step 2: Run to verify failure** (module doesn't exist yet — add the `mod` lines and an empty file first, then the tests fail to compile against missing items; that counts as the RED step for a new module)

```bash
cd prediction-engine && CARGO_TEST_ARGS='--lib numeric_transform -- --nocapture' docker compose -f docker-compose.test.yml run --rm prediction-engine-tests
```
Expected: compile error (`NumericTransform` not found).

- [ ] **Step 3: Implement**

```rust
// prediction-engine/src/numeric_transform.rs
//! Nominal <-> internal-coordinate mapping for numeric markets, following the
//! exact Metaculus transform (utils/the_math/formulas.py in their repo — see
//! docs/superpowers/specs/2026-07-17-open-tails-log-numeric-design.md).
//! Internal coordinate t is in [0,1]; bins are equal-width in t.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NumericTransform {
    pub range_min: f64,
    pub range_max: f64,
    pub zero_point: Option<f64>,
}

impl NumericTransform {
    fn span(&self) -> f64 {
        self.range_max - self.range_min
    }

    fn deriv_ratio(&self) -> Option<f64> {
        self.zero_point
            .map(|zp| (self.range_max - zp) / (self.range_min - zp))
    }

    pub fn validate(&self) -> Result<()> {
        if !self.range_min.is_finite() || !self.range_max.is_finite() {
            return Err(anyhow!("range bounds must be finite"));
        }
        if !(self.span() > 0.0) {
            return Err(anyhow!("range_max must exceed range_min"));
        }
        if let Some(zp) = self.zero_point {
            if !zp.is_finite() {
                return Err(anyhow!("zero_point must be finite"));
            }
            let d = self
                .deriv_ratio()
                .filter(|d| d.is_finite() && *d > 0.0)
                .ok_or_else(|| anyhow!("zero_point must lie strictly outside the range"))?;
            if (d - 1.0).abs() < 1e-12 || !d.ln().is_finite() {
                return Err(anyhow!("degenerate deriv_ratio for zero_point transform"));
            }
        }
        Ok(())
    }

    /// nominal -> t. Callers must have run validate(); on a degenerate shape
    /// this falls back to linear rather than returning NaN.
    pub fn to_internal(&self, x: f64) -> f64 {
        match self.deriv_ratio() {
            Some(d) if d > 0.0 && (d - 1.0).abs() >= 1e-12 => {
                (((x - self.range_min) * (d - 1.0) + self.span()).ln() - self.span().ln()) / d.ln()
            }
            _ => (x - self.range_min) / self.span(),
        }
    }

    /// t -> nominal.
    pub fn to_nominal(&self, t: f64) -> f64 {
        match self.deriv_ratio() {
            Some(d) if d > 0.0 && (d - 1.0).abs() >= 1e-12 => {
                self.range_min + self.span() * (d.powf(t) - 1.0) / (d - 1.0)
            }
            _ => self.range_min + self.span() * t,
        }
    }

    /// `bin_count` bins equal-width in t, returned as nominal (lower, upper)
    /// pairs. First lower and last upper are the exact range endpoints; the
    /// shared interior edges are computed once so bins are exactly contiguous.
    pub fn bin_edges_nominal(&self, bin_count: usize) -> Vec<(f64, f64)> {
        if bin_count == 0 || self.validate().is_err() {
            return Vec::new();
        }
        let mut edges = Vec::with_capacity(bin_count + 1);
        edges.push(self.range_min);
        for i in 1..bin_count {
            edges.push(self.to_nominal(i as f64 / bin_count as f64));
        }
        edges.push(self.range_max);
        (0..bin_count).map(|i| (edges[i], edges[i + 1])).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BucketKind {
    Inbound,
    LowerTail,
    UpperTail,
}

impl BucketKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "lower_tail" => BucketKind::LowerTail,
            "upper_tail" => BucketKind::UpperTail,
            _ => BucketKind::Inbound,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            BucketKind::Inbound => "inbound",
            BucketKind::LowerTail => "lower_tail",
            BucketKind::UpperTail => "upper_tail",
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd prediction-engine && CARGO_TEST_ARGS='--lib numeric_transform -- --nocapture' docker compose -f docker-compose.test.yml run --rm prediction-engine-tests
```
Expected: 7 passed. Then run the whole lib suite (default script) to confirm nothing broke.

- [ ] **Step 5: Commit**

```bash
git add prediction-engine/src/numeric_transform.rs prediction-engine/src/lib.rs prediction-engine/src/main.rs
git commit -m "feat(engine): NumericTransform with exact Metaculus zero_point mapping"
```

---

### Task 3: Seeder — log + open-bound markets

**Files:**
- Modify: `prediction-engine/src/market_import.rs:519-680` (`seed_numeric_bins_if_missing`)
- Modify: `prediction-engine/src/lmsr_multi_core.rs:397,405` (`format_bin_number`, `format_bin_label` become `pub`)
- Test: `prediction-engine/src/integration_tests.rs` (new tests)

**Interfaces:**
- Consumes: `NumericTransform`, `BucketKind` (Task 2); `event_outcomes.bucket_kind` (Task 1).
- Produces: seeded markets whose shape Tasks 4/5/6 rely on — inbound `bin_0..bin_{49}` sort 0..49 kind `'inbound'`, then `tail_low` (kind `'lower_tail'`, bounds `NULL`/`range_min`) and/or `tail_high` (kind `'upper_tail'`, bounds `range_max`/`NULL`) at the next sort_orders; config row `transform='log'|'linear'`, real `zero_point`/open flags, `binning_version=2`, `bin_count=50`, `b_numeric = subsidy/ln(outcome_count)`. Make the function `pub(crate)` if tests can't reach it.

- [ ] **Step 1: Write the failing integration tests** (append to `integration_tests.rs` tests module; reuse the file's `setup_test_database`/`cleanup_test_database` pattern; the stand-in `numeric_market_config` table must contain every column the INSERT writes — extend it like Task 1 did for `event_outcomes` if columns are missing, mirroring `backend/migrations/20260714_numeric_market_schema.sql`)

```rust
/// ImportedMarket with only the numeric shape varying — every ImportedMarket
/// field is required, so give the rest inert values.
fn numeric_test_market(
    range_min: Option<f64>,
    range_max: Option<f64>,
    zero_point: Option<f64>,
    open_lower: bool,
    open_upper: bool,
) -> crate::market_import::ImportedMarket {
    crate::market_import::ImportedMarket {
        source: "metaculus".to_string(),
        external_id: "e2e-test".to_string(),
        external_url: String::new(),
        title: "seed test".to_string(),
        description: String::new(),
        close_time: None,
        category: "test".to_string(),
        event_type: "numeric".to_string(),
        status: "open".to_string(),
        outcomes: Vec::new(),
        numeric_range_min: range_min,
        numeric_range_max: range_max,
        numeric_zero_point: zero_point,
        numeric_open_lower: open_lower,
        numeric_open_upper: open_upper,
        numeric_unit: None,
    }
}

#[tokio::test]
async fn test_seeder_creates_log_open_market_with_tails() -> Result<()> {
    let test_db = setup_test_database().await?;
    let pool = &test_db.pool;
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('log open numeric', NOW() + INTERVAL '30 days', 'numeric') RETURNING id",
    )
    .fetch_one(pool)
    .await?;

    let market = numeric_test_market(Some(1.0), Some(10000.0), Some(0.0), true, true);
    crate::market_import::seed_numeric_bins_if_missing(pool, event_id, &market).await?;

    let rows: Vec<(String, String, i32, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT outcome_key, bucket_kind, sort_order, lower_bound, upper_bound
         FROM event_outcomes WHERE event_id = $1 ORDER BY sort_order",
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?;
    assert_eq!(rows.len(), 52);
    assert_eq!(rows[0].0, "bin_0");
    assert_eq!(rows[0].3, Some(1.0));
    assert_eq!(rows[49].4, Some(10000.0));
    // log spacing: bin 25 starts at 10^(4*25/50) = 100
    assert!((rows[25].3.unwrap() - 100.0).abs() < 1e-6);
    assert_eq!((rows[50].0.as_str(), rows[50].1.as_str()), ("tail_low", "lower_tail"));
    assert_eq!((rows[50].3, rows[50].4), (None, Some(1.0)));
    assert_eq!((rows[51].0.as_str(), rows[51].1.as_str()), ("tail_high", "upper_tail"));
    assert_eq!((rows[51].3, rows[51].4), (Some(10000.0), None));

    let (transform, version, b, zp, ol, ou): (String, i32, f64, Option<f64>, bool, bool) = sqlx::query_as(
        "SELECT transform, binning_version, b_numeric, zero_point, open_lower_bound, open_upper_bound
         FROM numeric_market_config WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_one(pool)
    .await?;
    assert_eq!(transform, "log");
    assert_eq!(version, 2);
    assert!((b - 3466.0 / (52f64).ln()).abs() < 1e-6);
    assert_eq!(zp, Some(0.0));
    assert!(ol && ou);

    // uniform initial probs over all 52 outcomes
    let (n, minp, maxp): (i64, f64, f64) = sqlx::query_as(
        "SELECT COUNT(*), MIN(prob), MAX(prob) FROM event_outcome_states WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_one(pool)
    .await?;
    assert_eq!(n, 52);
    assert!((minp - 1.0 / 52.0).abs() < 1e-12 && (maxp - 1.0 / 52.0).abs() < 1e-12);

    cleanup_test_database(test_db.pool, &test_db.db_name).await?;
    Ok(())
}

#[tokio::test]
async fn test_seeder_closed_linear_market_unchanged_shape() -> Result<()> {
    let test_db = setup_test_database().await?;
    let pool = &test_db.pool;
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('closed linear numeric', NOW() + INTERVAL '30 days', 'numeric') RETURNING id",
    )
    .fetch_one(pool)
    .await?;

    let market = numeric_test_market(Some(0.0), Some(4.0), None, false, false);
    crate::market_import::seed_numeric_bins_if_missing(pool, event_id, &market).await?;

    let rows: Vec<(String, String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT outcome_key, bucket_kind, lower_bound, upper_bound
         FROM event_outcomes WHERE event_id = $1 ORDER BY sort_order",
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?;
    assert_eq!(rows.len(), 50, "closed market must have no tail rows");
    assert!(rows.iter().all(|r| r.1 == "inbound"));
    assert_eq!(rows[0].2, Some(0.0));
    assert_eq!(rows[49].3, Some(4.0));
    // equal-width in nominal space too (identity transform)
    assert!((rows[0].3.unwrap() - 0.08).abs() < 1e-9);

    let (transform, version, b): (String, i32, f64) = sqlx::query_as(
        "SELECT transform, binning_version, b_numeric FROM numeric_market_config WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_one(pool)
    .await?;
    assert_eq!(transform, "linear");
    assert_eq!(version, 2);
    assert!((b - 3466.0 / (50f64).ln()).abs() < 1e-6);

    cleanup_test_database(test_db.pool, &test_db.db_name).await?;
    Ok(())
}

#[tokio::test]
async fn test_seeder_still_skips_invalid_transform() -> Result<()> {
    let test_db = setup_test_database().await?;
    let pool = &test_db.pool;
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('bad zero_point', NOW() + INTERVAL '30 days', 'numeric') RETURNING id",
    )
    .fetch_one(pool)
    .await?;

    // zero_point INSIDE the range -> deriv_ratio < 0 -> unsupported, skip.
    let market = numeric_test_market(Some(0.0), Some(10.0), Some(5.0), false, false);
    crate::market_import::seed_numeric_bins_if_missing(pool, event_id, &market).await?;

    let outcome_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM event_outcomes WHERE event_id = $1")
            .bind(event_id)
            .fetch_one(pool)
            .await?;
    assert_eq!(outcome_count, 0);
    let config_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM numeric_market_config WHERE event_id = $1")
            .bind(event_id)
            .fetch_one(pool)
            .await?;
    assert_eq!(config_count, 0);

    cleanup_test_database(test_db.pool, &test_db.db_name).await?;
    Ok(())
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd prediction-engine && CARGO_TEST_ARGS='--bin prediction_engine test_seeder -- --nocapture' docker compose -f docker-compose.test.yml run --rm prediction-engine-tests
```
Expected: FAIL — 52-row assertion fails (seeder currently skips zero_point/open markets entirely), or compile error on visibility → make `seed_numeric_bins_if_missing` `pub(crate)`.

- [ ] **Step 3: Rewrite the seeder** (keep the existing early-returns for "already configured" and "already resolved"; replace the four shape filters and the bin/config writes)

```rust
pub(crate) async fn seed_numeric_bins_if_missing(
    pool: &PgPool,
    event_id: i32,
    market: &ImportedMarket,
) -> Result<()> {
    let (Some(range_min), Some(range_max)) =
        (market.numeric_range_min, market.numeric_range_max)
    else {
        return Ok(());
    };
    let transform = crate::numeric_transform::NumericTransform {
        range_min,
        range_max,
        zero_point: market.numeric_zero_point,
    };
    // Unsupported/degenerate shape (e.g. zero_point inside the range):
    // skip silently, same contract as the old filters.
    if transform.validate().is_err() {
        return Ok(());
    }

    // [UNCHANGED: existing_count check, resolved-outcome check — keep verbatim]

    let edges = transform.bin_edges_nominal(NUMERIC_BIN_COUNT);
    if edges.len() != NUMERIC_BIN_COUNT {
        return Ok(());
    }

    let open_lower = market.numeric_open_lower;
    let open_upper = market.numeric_open_upper;
    let outcome_count = NUMERIC_BIN_COUNT + open_lower as usize + open_upper as usize;

    let subsidy_rp: f64 = env::var("NUMERIC_MAX_SUBSIDY_RP")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(3466.0);
    let b_numeric = subsidy_rp / (outcome_count as f64).ln();
    let default_prob = 1.0 / outcome_count as f64;

    let mut tx = pool.begin().await?;

    // [UNCHANGED: events UPDATE (binds default_prob) and the two defensive
    //  DELETEs — keep verbatim]

    // One insert helper for outcome + state, used by bins and tails alike.
    async fn insert_outcome(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        event_id: i32,
        outcome_key: &str,
        label: &str,
        sort_order: i32,
        lower: Option<f64>,
        upper: Option<f64>,
        bucket_kind: &str,
        default_prob: f64,
    ) -> Result<()> {
        let outcome_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO event_outcomes
                (event_id, outcome_key, label, sort_order, lower_bound, upper_bound, bucket_kind)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            "#,
        )
        .bind(event_id)
        .bind(outcome_key)
        .bind(label)
        .bind(sort_order)
        .bind(lower)
        .bind(upper)
        .bind(bucket_kind)
        .fetch_one(tx.as_mut())
        .await?;
        sqlx::query(
            r#"
            INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob, updated_at)
            VALUES ($1, $2, 0.0, $3, NOW())
            ON CONFLICT (event_id, outcome_id)
            DO UPDATE SET q_value = EXCLUDED.q_value, prob = EXCLUDED.prob, updated_at = NOW()
            "#,
        )
        .bind(event_id)
        .bind(outcome_id)
        .bind(default_prob)
        .execute(tx.as_mut())
        .await?;
        Ok(())
    }

    let unit = market.numeric_unit.as_deref();
    for (idx, (lower, upper)) in edges.iter().enumerate() {
        let label = crate::lmsr_multi_core::format_bin_label(*lower, *upper, unit);
        insert_outcome(
            &mut tx, event_id, &format!("bin_{idx}"), &label, idx as i32,
            Some(*lower), Some(*upper), "inbound", default_prob,
        )
        .await?;
    }

    let with_unit = |base: String| match unit {
        Some(u) if !u.is_empty() => format!("{base} {u}"),
        _ => base,
    };
    let mut sort = NUMERIC_BIN_COUNT as i32;
    if open_lower {
        let label = with_unit(format!(
            "< {}",
            crate::lmsr_multi_core::format_bin_number(range_min)
        ));
        insert_outcome(
            &mut tx, event_id, "tail_low", &label, sort,
            None, Some(range_min), "lower_tail", default_prob,
        )
        .await?;
        sort += 1;
    }
    if open_upper {
        let label = with_unit(format!(
            "> {}",
            crate::lmsr_multi_core::format_bin_number(range_max)
        ));
        insert_outcome(
            &mut tx, event_id, "tail_high", &label, sort,
            Some(range_max), None, "upper_tail", default_prob,
        )
        .await?;
    }

    sqlx::query(
        r#"
        INSERT INTO numeric_market_config
            (event_id, range_min, range_max, zero_point, open_lower_bound, open_upper_bound,
             unit, bin_count, transform, binning_version, b_numeric, numeric_market_version)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, $10, 0)
        ON CONFLICT (event_id) DO NOTHING
        "#,
    )
    .bind(event_id)
    .bind(range_min)
    .bind(range_max)
    .bind(market.numeric_zero_point)
    .bind(open_lower)
    .bind(open_upper)
    .bind(&market.numeric_unit)
    .bind(NUMERIC_BIN_COUNT as i32)
    .bind(if market.numeric_zero_point.is_some() { "log" } else { "linear" })
    .bind(b_numeric)
    .execute(tx.as_mut())
    .await?;

    tx.commit().await?;
    Ok(())
}
```

Also change `fn format_bin_number` → `pub fn format_bin_number` and `fn format_bin_label` → `pub fn format_bin_label` in `lmsr_multi_core.rs`. Update the doc comment on the seeder (it no longer skips zero_point/open shapes).

- [ ] **Step 4: Run tests to verify they pass** (same command as Step 2, expected 3 passed), then the default lib suite for regressions.

- [ ] **Step 5: Commit**

```bash
git add prediction-engine/src/market_import.rs prediction-engine/src/lmsr_multi_core.rs prediction-engine/src/integration_tests.rs
git commit -m "feat(engine): seed log-scaled and open-bounded numeric markets with tail outcomes"
```

---

### Task 4: Resolution — tails win out-of-range values (shared picker)

**Files:**
- Modify: `prediction-engine/src/numeric_transform.rs` (add `pick_winning_outcome`)
- Modify: `prediction-engine/src/lmsr_api.rs:1964-2011` (`resolve_numeric_event`)
- Modify: `prediction-engine/src/resolution_sync.rs:615-635` (replace `pick_winning_bin` body with a call to the shared picker; its query at ~line 335 gains `bucket_kind`)
- Test: unit tests move/extend in `numeric_transform.rs`; integration tests in `integration_tests.rs`

**Interfaces:**
- Consumes: `BucketKind` (Task 2), seeded tail rows (Task 3).
- Produces (Task 9's fixtures rely on the exact semantics):

```rust
pub fn pick_winning_outcome(
    rows: &[(i64, BucketKind, Option<f64>, Option<f64>)], // (outcome_id, kind, lower, upper) in sort_order
    value: f64,
) -> Option<i64>
```

- [ ] **Step 1: Write the failing unit tests** (in `numeric_transform.rs`; port the eight `pick_winning_bin_*` cases from `resolution_sync.rs:705-760` to the new signature — all inbound rows get `BucketKind::Inbound` — and add the tail cases)

```rust
fn tailed_rows() -> Vec<(i64, BucketKind, Option<f64>, Option<f64>)> {
    vec![
        (1, BucketKind::Inbound, Some(0.0), Some(10.0)),
        (2, BucketKind::Inbound, Some(10.0), Some(20.0)),
        (3, BucketKind::LowerTail, None, Some(0.0)),
        (4, BucketKind::UpperTail, Some(20.0), None),
    ]
}

#[test]
fn below_range_goes_to_lower_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), -0.5), Some(3)); }
#[test]
fn above_range_goes_to_upper_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), 20.5), Some(4)); }
#[test]
fn exact_range_min_goes_to_first_inbound_not_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), 0.0), Some(1)); }
#[test]
fn exact_range_max_goes_to_last_inbound_not_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), 20.0), Some(2)); }
#[test]
fn out_of_range_without_tails_is_none() {
    let closed = vec![
        (1, BucketKind::Inbound, Some(0.0), Some(10.0)),
        (2, BucketKind::Inbound, Some(10.0), Some(20.0)),
    ];
    assert_eq!(pick_winning_outcome(&closed, -1.0), None);
    assert_eq!(pick_winning_outcome(&closed, 21.0), None);
}
```

- [ ] **Step 2: Run to verify failure** (compile error: function missing). Same test command pattern, filter `numeric_transform`.

- [ ] **Step 3: Implement the picker**

```rust
/// Winning outcome for a resolved nominal value, per the spec's semantics
/// table: strictly below range -> lower tail, strictly above -> upper tail,
/// exact endpoints land in the first/last inbound bin, interior values scan
/// [lower, upper) with the last inbound bin closed on its upper bound.
/// Ambiguous (overlapping inbound bins) or unmatchable values return None.
pub fn pick_winning_outcome(
    rows: &[(i64, BucketKind, Option<f64>, Option<f64>)],
    value: f64,
) -> Option<i64> {
    if !value.is_finite() || rows.is_empty() {
        return None;
    }
    let inbound: Vec<&(i64, BucketKind, Option<f64>, Option<f64>)> =
        rows.iter().filter(|r| r.1 == BucketKind::Inbound).collect();
    if inbound.is_empty() {
        return None;
    }
    // Inbound bins always carry bounds for numeric markets (the seeder writes
    // them); a missing endpoint here is corrupt data — fail safe with None.
    let range_min = inbound.first()?.2?;
    let range_max = inbound.last()?.3?;
    if value < range_min {
        return rows.iter().find(|r| r.1 == BucketKind::LowerTail).map(|r| r.0);
    }
    if value > range_max {
        return rows.iter().find(|r| r.1 == BucketKind::UpperTail).map(|r| r.0);
    }
    let last_idx = inbound.len() - 1;
    let mut matches = inbound.iter().enumerate().filter_map(|(idx, (id, _, lower, upper))| {
        let lower_ok = lower.map(|v| value >= v).unwrap_or(true);
        let upper_ok = upper
            .map(|v| if idx == last_idx { value <= v } else { value < v })
            .unwrap_or(true);
        (lower_ok && upper_ok).then_some(*id)
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        None // ambiguous — fail safe
    } else {
        Some(first)
    }
}
```

- [ ] **Step 4: Wire both call sites**

`resolve_numeric_event` (lmsr_api.rs): the SELECT gains `bucket_kind`; the manual scan loop is replaced by:

```rust
let picker_rows: Vec<(i64, crate::numeric_transform::BucketKind, Option<f64>, Option<f64>)> = rows
    .iter()
    .map(|row| {
        (
            row.get::<i64, _>("id"),
            crate::numeric_transform::BucketKind::parse(&row.get::<String, _>("bucket_kind")),
            row.get::<Option<f64>, _>("lower_bound"),
            row.get::<Option<f64>, _>("upper_bound"),
        )
    })
    .collect();
let winner_outcome_id = crate::numeric_transform::pick_winning_outcome(&picker_rows, value)
    .ok_or_else(|| {
        anyhow!("Numeric value does not fit configured buckets for this market")
    })?;
```

(Note: this also makes the API path fail safe on overlapping bins — the old loop took the first match. Deliberate.)

`resolution_sync.rs`: the bins query gains `bucket_kind`; the tuple gains the parsed kind; `pick_winning_bin` becomes a thin delegating wrapper (or is deleted and the call site calls the shared picker directly); its local unit tests move to `numeric_transform.rs` (Step 1 already ported them — delete the originals).

- [ ] **Step 5: Write + run the failing integration test — a tail actually pays out** (append to `integration_tests.rs`; setup mirrors `test_numeric_settlement_pays_out_and_clears_positions` at line ~1956)

```rust
#[tokio::test]
async fn test_numeric_settlement_pays_out_upper_tail_winner() -> Result<()> {
    let test_db = setup_test_database().await?;
    let pool = &test_db.pool;
    // 4 inbound bins [0,1)..[3,4] plus an upper tail; resolution value 7.5 -> tail wins.
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('settle tail', NOW() - INTERVAL '1 hour', 'numeric') RETURNING id",
    )
    .fetch_one(pool)
    .await?;
    sqlx::query(
        "INSERT INTO numeric_market_config
            (event_id, range_min, range_max, bin_count, b_numeric, open_upper_bound)
         VALUES ($1, 0, 4, 4, 886.0, TRUE)",
    )
    .bind(event_id)
    .execute(pool)
    .await?;
    let mut outcome_ids = Vec::new();
    for i in 0..4i32 {
        let oid: i64 = sqlx::query_scalar(
            "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound, bucket_kind)
             VALUES ($1, $2, $3, $4, $5, $6, 'inbound') RETURNING id",
        )
        .bind(event_id).bind(format!("bin_{i}")).bind(format!("{i}-{}", i + 1))
        .bind(i).bind(i as f64).bind((i + 1) as f64)
        .fetch_one(pool).await?;
        outcome_ids.push(oid);
    }
    let tail_id: i64 = sqlx::query_scalar(
        "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound, bucket_kind)
         VALUES ($1, 'tail_high', '> 4', 4, 4.0, NULL, 'upper_tail') RETURNING id",
    )
    .bind(event_id)
    .fetch_one(pool)
    .await?;

    let u1: i32 = sqlx::query_scalar(
        "INSERT INTO users (username, email, password_hash, rp_balance_ledger, rp_staked_ledger)
         VALUES ('tail_u1', 't1@test', 'x', 100000000, 4000000) RETURNING id",
    ).fetch_one(pool).await?;
    sqlx::query(
        "INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
         VALUES ($1, $2, $3, 3.0, 0)",
    ).bind(u1).bind(event_id).bind(tail_id).execute(pool).await?;
    sqlx::query("INSERT INTO numeric_position_basis (user_id, event_id, basis_ledger) VALUES ($1, $2, 4000000)")
        .bind(u1).bind(event_id).execute(pool).await?;

    let winner = crate::lmsr_api::resolve_numeric_event(pool, event_id, 7.5).await?;
    assert_eq!(winner, tail_id, "value above range_max must resolve to the upper tail");

    // 3.0 winning shares * 1 RP payout; stake released.
    let (b1, s1): (i64, i64) = sqlx::query_as(
        "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1",
    ).bind(u1).fetch_one(pool).await?;
    assert_eq!((b1, s1), (103_000_000, 0));
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_outcome_shares WHERE event_id = $1")
        .bind(event_id).fetch_one(pool).await?;
    assert_eq!(remaining, 0);

    cleanup_test_database(test_db.pool, &test_db.db_name).await?;
    Ok(())
}

#[tokio::test]
async fn test_numeric_resolution_out_of_range_still_errors_without_tails() -> Result<()> {
    let test_db = setup_test_database().await?;
    let pool = &test_db.pool;
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('closed no tails', NOW() - INTERVAL '1 hour', 'numeric') RETURNING id",
    )
    .fetch_one(pool)
    .await?;
    for i in 0..4i32 {
        sqlx::query(
            "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound, bucket_kind)
             VALUES ($1, $2, $3, $4, $5, $6, 'inbound')",
        )
        .bind(event_id).bind(format!("bin_{i}")).bind(format!("{i}-{}", i + 1))
        .bind(i).bind(i as f64).bind((i + 1) as f64)
        .execute(pool).await?;
    }
    let err = crate::lmsr_api::resolve_numeric_event(pool, event_id, 7.5)
        .await
        .expect_err("out-of-range value on a closed market must fail");
    assert!(err.to_string().contains("does not fit"), "{err}");
    cleanup_test_database(test_db.pool, &test_db.db_name).await?;
    Ok(())
}
```

Note: the stand-in `numeric_market_config` table needs an `open_upper_bound` column (and `open_lower_bound`, `transform`, `binning_version`, `zero_point` if missing) mirroring the real migration — extend it in `setup_test_database` the way Task 1 extended `event_outcomes`.

- [ ] **Step 6: Run all engine tests**

```bash
./scripts/test_prediction_engine.sh --full
```
Expected: all pass (container exit 0).

- [ ] **Step 7: Commit**

```bash
git add prediction-engine/src/numeric_transform.rs prediction-engine/src/lmsr_api.rs prediction-engine/src/resolution_sync.rs prediction-engine/src/integration_tests.rs
git commit -m "feat(engine): out-of-range numeric resolutions settle into tail outcomes"
```

---

### Task 5: Quote/trade accept the enlarged outcome vector

**Files:**
- Modify: `prediction-engine/src/lmsr_api.rs:1316-1348` (`NumericMarketRow` + its two fetch queries), `:1418-1462` (`get_numeric_quote`), and the same length checks inside `numeric_trade_transaction` (~1510-1530 — grep `validate_target` and `bin_count` for every call site)
- Test: `prediction-engine/src/integration_tests.rs`

**Interfaces:**
- Consumes: seeded 51/52-outcome markets (Task 3).
- Produces: `NumericMarketRow { …, open_lower_bound: bool, open_upper_bound: bool }` with `fn expected_outcome_count(&self) -> usize` — Task 6 does not depend on it, but Task 9's E2E trade does.

- [ ] **Step 1: Write the failing integration test**

```rust
#[tokio::test]
async fn test_numeric_quote_accepts_tail_outcome_vector() -> Result<()> {
    let test_db = setup_test_database().await?;
    let pool = &test_db.pool;
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, closing_date, event_type)
         VALUES ('quote tails', NOW() + INTERVAL '30 days', 'numeric') RETURNING id",
    )
    .fetch_one(pool)
    .await?;
    // Task 3's helper: log market, both bounds open -> 52 outcomes.
    let market = numeric_test_market(Some(1.0), Some(10000.0), Some(0.0), true, true);
    crate::market_import::seed_numeric_bins_if_missing(pool, event_id, &market).await?;

    let target = vec![1.0 / 52.0; 52];
    let quote = crate::lmsr_api::get_numeric_quote(pool, event_id, 5_000_000, target).await?;
    assert!(quote.cost_ledger >= 0);
    assert_eq!(quote.post_distribution.len(), 52);

    // A 50-length target against the 52-outcome market must be rejected.
    let short = vec![1.0 / 50.0; 50];
    let err = crate::lmsr_api::get_numeric_quote(pool, event_id, 5_000_000, short)
        .await
        .expect_err("length mismatch must fail");
    assert!(err.to_string().contains("exactly 52"), "{err}");

    cleanup_test_database(test_db.pool, &test_db.db_name).await?;
    Ok(())
}
```

- [ ] **Step 2: Run to verify failure** — expected: first quote call fails with "target must have exactly 50 entries, got 52".

- [ ] **Step 3: Implement**

`NumericMarketRow` gains the flags, both `fetch_numeric_market_row_*` SELECTs add `c.open_lower_bound, c.open_upper_bound`, and:

```rust
impl NumericMarketRow {
    /// Inbound bins + tail outcomes; the length every q/target vector must have.
    fn expected_outcome_count(&self) -> usize {
        self.bin_count as usize
            + self.open_lower_bound as usize
            + self.open_upper_bound as usize
    }
}
```

In `get_numeric_quote` and `numeric_trade_transaction`, replace every `let bin_count = market.bin_count as usize;` + its uses with `let outcome_count = market.expected_outcome_count();` — `validate_target(&target, outcome_count)?` and the `q.len() != outcome_count` guard (update that error message's wording from "bin_count" to "outcome count" accordingly).

- [ ] **Step 4: Run the test (pass) + full engine suite** (same commands as Task 4 Step 6).

- [ ] **Step 5: Commit**

```bash
git add prediction-engine/src/lmsr_api.rs prediction-engine/src/integration_tests.rs
git commit -m "feat(engine): numeric quote/trade validate against inbound+tail outcome count"
```

---

### Task 6: Market-state exposes `numeric_config` and `bucket_kind`

**Files:**
- Modify: `prediction-engine/src/lmsr_api.rs:2267-…` (`get_market_state`)
- Test: `prediction-engine/src/integration_tests.rs` (extend `test_market_state_exposes_numeric_market_version` or add a sibling)

**Interfaces:**
- Produces (Tasks 7/8 consume): response gains top-level `"numeric_config"` — `{ "transform", "zero_point", "range_min", "range_max", "open_lower_bound", "open_upper_bound", "unit", "bin_count" }` or JSON `null` for events without a config row — and each non-binary outcome object gains `"bucket_kind"`.

- [ ] **Step 1: Write the failing integration test** — seed a log+open market (Task 3 helper pattern), call `crate::lmsr_api::get_market_state(pool, event_id)`, assert:

```rust
let cfg = &state["numeric_config"];
assert_eq!(cfg["transform"], "log");
assert_eq!(cfg["range_min"], 1.0);
assert_eq!(cfg["open_upper_bound"], true);
let outcomes = state["outcomes"].as_array().unwrap();
assert_eq!(outcomes.len(), 52);
assert_eq!(outcomes[51]["bucket_kind"], "upper_tail");
// and: a binary event's state has numeric_config == serde_json::Value::Null
```

- [ ] **Step 2: Run to verify failure** (field missing → `Null` comparison fails).

- [ ] **Step 3: Implement.** In `get_market_state`: add one query after the outcome rows fetch —

```rust
let numeric_config = sqlx::query(
    "SELECT range_min, range_max, zero_point, open_lower_bound, open_upper_bound, unit, transform, bin_count
     FROM numeric_market_config WHERE event_id = $1",
)
.bind(event_id)
.fetch_optional(pool)
.await?
.map(|c| {
    serde_json::json!({
        "transform": c.get::<String, _>("transform"),
        "zero_point": c.get::<Option<f64>, _>("zero_point"),
        "range_min": c.get::<f64, _>("range_min"),
        "range_max": c.get::<f64, _>("range_max"),
        "open_lower_bound": c.get::<bool, _>("open_lower_bound"),
        "open_upper_bound": c.get::<bool, _>("open_upper_bound"),
        "unit": c.get::<Option<String>, _>("unit"),
        "bin_count": c.get::<i32, _>("bin_count"),
    })
})
.unwrap_or(serde_json::Value::Null);
```

Add `eo.bucket_kind` to the outcome-rows SELECT, `"bucket_kind": outcome_row.get::<String, _>("bucket_kind")` to the non-binary outcome JSON object, and `"numeric_config": numeric_config` as a sibling of `"numeric_market_version"` in the response JSON. (The backend proxies this response verbatim to the frontend — verify by greping backend for the market-state route; no backend change expected.)

- [ ] **Step 4: Run the test (pass) + default lib suite.**

- [ ] **Step 5: Commit**

```bash
git add prediction-engine/src/lmsr_api.rs prediction-engine/src/integration_tests.rs
git commit -m "feat(engine): market state exposes numeric_config and bucket_kind"
```

---

### Task 7: Frontend math — transform + t-space fit (additive, node:test)

**Files:**
- Modify: `frontend-solid/src/utils/distributionMath.js` (ADD new exports; do NOT touch the existing `fitDistribution`/`quantileFromBins` — the card still uses them until Task 8)
- Create: `frontend-solid/src/utils/distributionMath.test.js`

**Interfaces:**
- Produces (Task 8 consumes):
  - `makeTransform(config)` → `{ rangeMin, rangeMax, toInternal(x), toNominal(t) } | null` — `config` is the engine's `numeric_config` object (snake_case keys), null-zero_point = linear; returns `null` for missing/degenerate config.
  - `fitDistributionFromState({ low, center, high, rows, config })` → mass array **aligned with `rows` order** (the market-state outcome order: inbound then tails); handles in nominal units.
  - `quantileFromState(rows, config, q)` → nominal value clamped to `[rangeMin, rangeMax]`.

- [ ] **Step 1: Write the failing tests**

```js
// frontend-solid/src/utils/distributionMath.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTransform,
  fitDistributionFromState,
  quantileFromState
} from './distributionMath.js';

const LOG_CFG = { range_min: 1, range_max: 10000, zero_point: 0, open_lower_bound: true, open_upper_bound: true };
const LIN_CFG = { range_min: 0, range_max: 4, zero_point: null, open_lower_bound: false, open_upper_bound: false };

const mkRows = (n, cfg) => {
  const tf = makeTransform(cfg);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      outcome_id: i + 1,
      bucket_kind: 'inbound',
      lower_bound: tf.toNominal(i / n),
      upper_bound: tf.toNominal((i + 1) / n),
      prob: 1 / n
    });
  }
  return rows;
};

test('makeTransform log matches the Metaculus identity 10^(4t)', () => {
  const tf = makeTransform(LOG_CFG);
  assert.ok(Math.abs(tf.toNominal(0.5) - 100) < 1e-6);
  assert.ok(Math.abs(tf.toInternal(10) - 0.25) < 1e-9);
});

test('makeTransform rejects degenerate configs', () => {
  assert.equal(makeTransform(null), null);
  assert.equal(makeTransform({ range_min: 0, range_max: 10, zero_point: 5 }), null); // zp inside range
  assert.equal(makeTransform({ range_min: 5, range_max: 1, zero_point: null }), null);
});

test('fitDistributionFromState pushes out-of-range mass into tails', () => {
  const rows = mkRows(4, LOG_CFG);
  rows.push({ outcome_id: 90, bucket_kind: 'lower_tail', lower_bound: null, upper_bound: 1, prob: 0 });
  rows.push({ outcome_id: 91, bucket_kind: 'upper_tail', lower_bound: 10000, upper_bound: null, prob: 0 });
  // Handles hug the very top of the range -> real mass must land in the upper tail.
  const u = fitDistributionFromState({ low: 5000, center: 9000, high: 9999, rows, config: LOG_CFG });
  assert.equal(u.length, 6);
  const sum = u.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(u[5] > 0.01, `upper tail got ${u[5]}`);
  assert.ok(u[4] < 1e-5, `lower tail should be floor-level, got ${u[4]}`);
});

test('fitDistributionFromState closed market renormalizes like the legacy fit', () => {
  const rows = mkRows(4, LIN_CFG);
  const u = fitDistributionFromState({ low: 1, center: 2, high: 3, rows, config: LIN_CFG });
  assert.equal(u.length, 4);
  assert.ok(Math.abs(u.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // symmetric handles on a linear market -> symmetric mass
  assert.ok(Math.abs(u[0] - u[3]) < 1e-9 && Math.abs(u[1] - u[2]) < 1e-9);
  assert.ok(u[1] > u[0]);
});

test('quantileFromState inverts a uniform distribution in t-space', () => {
  const rows = mkRows(4, LOG_CFG);
  // uniform mass over t -> P50 sits at t=0.5 -> nominal 100 on the log market
  const p50 = quantileFromState(rows, LOG_CFG, 0.5);
  assert.ok(Math.abs(p50 - 100) < 1, `got ${p50}`);
  // clamps into range even when tails hold mass
  rows.push({ outcome_id: 91, bucket_kind: 'upper_tail', lower_bound: 10000, upper_bound: null, prob: 0.5 });
  assert.ok(quantileFromState(rows, LOG_CFG, 0.99) <= 10000);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd frontend-solid && node --test src/utils/distributionMath.test.js
```
Expected: FAIL — `makeTransform` is not exported.

- [ ] **Step 3: Implement** (append to `distributionMath.js`)

```js
/**
 * Transform between nominal values and Metaculus's internal coordinate
 * t in [0,1]. zero_point == null means linear. Formulas are verbatim from
 * Metaculus utils/the_math/formulas.py (see the 2026-07-17 design spec) —
 * with d = (range_max - zero_point) / (range_min - zero_point).
 * Returns null for missing or degenerate configs (caller falls back).
 */
export function makeTransform(config) {
  if (!config) return null;
  const rangeMin = Number(config.range_min);
  const rangeMax = Number(config.range_max);
  const zeroPoint = config.zero_point == null ? null : Number(config.zero_point);
  const span = rangeMax - rangeMin;
  if (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax) || !(span > 0)) return null;
  if (zeroPoint == null) {
    return {
      rangeMin,
      rangeMax,
      toInternal: (x) => (x - rangeMin) / span,
      toNominal: (t) => rangeMin + span * t
    };
  }
  if (!Number.isFinite(zeroPoint)) return null;
  const d = (rangeMax - zeroPoint) / (rangeMin - zeroPoint);
  if (!Number.isFinite(d) || d <= 0 || Math.abs(d - 1) < 1e-12) return null;
  const lnD = Math.log(d);
  return {
    rangeMin,
    rangeMax,
    toInternal: (x) => (Math.log((x - rangeMin) * (d - 1) + span) - Math.log(span)) / lnD,
    toNominal: (t) => rangeMin + span * (Math.pow(d, t) - 1) / (d - 1)
  };
}

const rowKind = (row) => row?.bucket_kind || 'inbound';
const inboundOf = (rows) => rows.filter((r) => rowKind(r) === 'inbound');

// Linear fallback transform derived from inbound bin bounds, for stale
// backends that don't send numeric_config yet (degraded display, not a
// correctness risk — see the design spec's Error handling section).
const fallbackTransform = (rows) => {
  const inbound = inboundOf(rows);
  if (inbound.length === 0) return null;
  return makeTransform({
    range_min: Number(inbound[0].lower_bound),
    range_max: Number(inbound[inbound.length - 1].upper_bound),
    zero_point: null
  });
};

/**
 * Split-normal fit in t-space. Returns one mass per row, aligned with the
 * given rows order (market-state order: inbound bins then tails). Mass below
 * t=0 / above t=1 goes to the lower/upper tail row when present and is
 * dropped otherwise; the vector is floored at TARGET_MASS_FLOOR and
 * renormalized to 1 (identical to the legacy closed-market behavior).
 */
export function fitDistributionFromState({ low, center, high, rows, config }) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const tf = makeTransform(config) || fallbackTransform(rows);
  if (!tf) return rows.map(() => 1 / rows.length);
  const n = inboundOf(rows).length;
  if (n === 0) return rows.map(() => 1 / rows.length);

  const tc = tf.toInternal(center);
  const { sigmaLeft, sigmaRight } = computeSigmas(
    tf.toInternal(low), tc, tf.toInternal(high), 0, 1
  );
  const cdf = (t) => splitNormalCdf(t, tc, sigmaLeft, sigmaRight);

  let inboundIdx = 0;
  const raw = rows.map((row) => {
    const kind = rowKind(row);
    if (kind === 'lower_tail') return Math.max(cdf(0), 0);
    if (kind === 'upper_tail') return Math.max(1 - cdf(1), 0);
    const i = inboundIdx;
    inboundIdx += 1;
    return Math.max(cdf((i + 1) / n) - cdf(i / n), 0);
  });

  const floored = raw.map((v) => (Number.isFinite(v) ? Math.max(v, TARGET_MASS_FLOOR) : TARGET_MASS_FLOOR));
  const sum = floored.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return rows.map(() => 1 / rows.length);
  return floored.map((v) => v / sum);
}

/**
 * Quantile of the market's current per-row distribution, computed in t-space
 * (walk order: lower tail, inbound bins, upper tail) and returned as a
 * nominal value clamped into [rangeMin, rangeMax] — tail mass "lands" on the
 * nearest range endpoint since tails have no interior coordinates.
 */
export function quantileFromState(rows, config, q) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const tf = makeTransform(config) || fallbackTransform(rows);
  if (!tf) return 0;
  const inbound = inboundOf(rows);
  const n = inbound.length;
  const lowerTail = rows.find((r) => rowKind(r) === 'lower_tail');
  const upperTail = rows.find((r) => rowKind(r) === 'upper_tail');
  const mass = (row) => Math.max(Number(row?.prob) || 0, 0);

  let cumulative = mass(lowerTail || {});
  if (cumulative >= q) return tf.rangeMin;
  for (let i = 0; i < n; i++) {
    const m = mass(inbound[i]);
    if (cumulative + m >= q) {
      const frac = m > 0 ? (q - cumulative) / m : 0;
      return tf.toNominal((i + frac) / n);
    }
    cumulative += m;
  }
  return upperTail ? tf.rangeMax : tf.toNominal(1);
}
```

- [ ] **Step 4: Run tests to verify they pass** (same command; also `node --test src/lib/*.test.js` still green).

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/utils/distributionMath.js frontend-solid/src/utils/distributionMath.test.js
git commit -m "feat(frontend): t-space distribution fit with tail mass and transform-aware quantiles"
```

---

### Task 8: DistributionMarketCard — t-space chart, ticks, edge bars

**Files:**
- Modify: `frontend-solid/src/components/predictions/DistributionMarketCard.jsx`
- Modify: `frontend-solid/src/utils/distributionMath.js` (DELETE the now-unused `fitDistribution` and `quantileFromBins`; keep `applySpreadPreset`)
- Modify: the stylesheet defining `.distribution-card-chart` (grep `distribution-card-market-area` under `frontend-solid/src/`) — new classes below.

**Interfaces:**
- Consumes: `makeTransform` / `fitDistributionFromState` / `quantileFromState` (Task 7); `numeric_config` + `bucket_kind` (Task 6).
- Produces: DOM hooks Task 9's E2E relies on: `.distribution-card-tail-bar` (one `rect` per open side), `.distribution-card-axis-label` tick texts, and unchanged existing hooks (`.distribution-card-handle-input`, `.distribution-card-budget-input`, `.distribution-card-chart`).

Card changes, piece by piece (line refs are pre-change):

- [ ] **Step 1: State + geometry plumbing**

```jsx
// imports: replace fitDistribution/quantileFromBins with
//   makeTransform, fitDistributionFromState, quantileFromState
// consts: add
const TAIL_W = 20;
const TAIL_GAP = 6;
const AXIS_H = 14;
const fmtTick = (v) =>
  Number.isFinite(Number(v))
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 }).format(Number(v))
    : '';

// signals: add
const [numericConfig, setNumericConfig] = createSignal(null);
// in loadMarketState, next to setMarketVersion:
setNumericConfig(state?.numeric_config ?? null);
// (and setNumericConfig(null) in the error branch)

// derived rows / transform (replace the old rangeMin/rangeMax at lines 127-128):
const inboundBins = () => bins().filter((b) => (b.bucket_kind || 'inbound') === 'inbound');
const tailLow = () => bins().find((b) => b.bucket_kind === 'lower_tail') || null;
const tailHigh = () => bins().find((b) => b.bucket_kind === 'upper_tail') || null;
const transform = createMemo(() => {
  const ib = inboundBins();
  return (
    makeTransform(numericConfig()) ||
    makeTransform({
      range_min: ib[0] ? Number(ib[0].lower_bound) : 0,
      range_max: ib.length ? Number(ib[ib.length - 1].upper_bound) : 1,
      zero_point: null
    })
  );
});
const rangeMin = () => transform()?.rangeMin ?? 0;
const rangeMax = () => transform()?.rangeMax ?? 1;

// geometry (replace toX at 215-218 and adjust toY/baseline at 227-230):
const plotLeft = () => PAD_X + (tailLow() ? TAIL_W + TAIL_GAP : 0);
const plotRight = () => CHART_W - PAD_X - (tailHigh() ? TAIL_W + TAIL_GAP : 0);
const toX = (t) => plotLeft() + clamp(t, 0, 1) * (plotRight() - plotLeft());
const baselineY = () => CHART_H - PAD_Y - AXIS_H;
const toY = (mass) => {
  const clamped = clamp(safeNumber(mass), 0, yMax());
  return baselineY() - (clamped / yMax()) * (baselineY() - PAD_Y);
};
```

- [ ] **Step 2: Step paths over inbound t-edges** (replace `stepPoints`/`areaPath` bodies; `values` stays aligned with the full `bins()` order)

```jsx
const stepPoints = (values) => {
  const rows = bins();
  const n = inboundBins().length;
  if (n === 0) return [];
  const pts = [];
  let i = 0;
  rows.forEach((row, idx) => {
    if ((row.bucket_kind || 'inbound') !== 'inbound') return;
    const x0 = toX(i / n).toFixed(2);
    const x1 = toX((i + 1) / n).toFixed(2);
    const y = toY(values[idx]).toFixed(2);
    pts.push(`${x0},${y}`, `${x1},${y}`);
    i += 1;
  });
  return pts;
};

const areaPath = (values) => {
  if (inboundBins().length === 0) return '';
  const baseline = baselineY().toFixed(2);
  const pts = stepPoints(values);
  return `M ${toX(0).toFixed(2)},${baseline} L ${pts.join(' L ')} L ${toX(1).toFixed(2)},${baseline} Z`;
};
```

`positionTicks` (lines 274-287): filter to inbound rows and compute x from t-edges exactly like `stepPoints` (walk with an inbound counter; `x0 = toX(i / n)`, `x1 = toX((i + 1) / n)`).

`previewLinePath` keeps its `post.length === bins().length` guard (now 52-aligned).

- [ ] **Step 3: Handles, fit, quantiles in the new space**

```jsx
// targetU (replaces lines 202-212):
const targetU = createMemo(() => {
  if (bins().length === 0) return [];
  return fitDistributionFromState({
    low: low(), center: center(), high: high(),
    rows: bins(), config: numericConfig()
  });
});

// handle init inside loadMarketState (replaces quantileFromBins calls):
const p10 = quantileFromState(rows, state?.numeric_config ?? null, 0.10);
const p50 = quantileFromState(rows, state?.numeric_config ?? null, 0.50);
const p90 = quantileFromState(rows, state?.numeric_config ?? null, 0.90);

// handle guide x positions in the SVG (three <line> elements at 564-575):
x1={toX(transform()?.toInternal(low()) ?? 0)} // etc. for center()/high()
```

`updateLow`/`updateCenter`/`updateHigh` and `applyPreset` keep operating in nominal values against `rangeMin()`/`rangeMax()` — unchanged code, still correct (presets scale nominal spreads; acceptable UX on log markets, revisit only if it feels wrong in use).

- [ ] **Step 4: Edge bars + axis ticks (new JSX inside the `<svg>`, after the handle guide lines)**

```jsx
{/* axis tick labels — nominal values at nice t positions */}
<For each={[0, 0.25, 0.5, 0.75, 1]}>
  {(t) => (
    <text class="distribution-card-axis-label" x={toX(t)} y={CHART_H - 3} text-anchor="middle">
      {fmtTick(transform()?.toNominal(t))}
    </text>
  )}
</For>

{/* tail edge bars: market prob as a filled bar, target mass as a line */}
<Show when={tailLow()}>
  <rect
    class="distribution-card-tail-bar"
    x={PAD_X}
    y={toY(safeNumber(tailLow().prob))}
    width={TAIL_W}
    height={Math.max(baselineY() - toY(safeNumber(tailLow().prob)), 0.5)}
  />
  <text class="distribution-card-tail-pct" x={PAD_X + TAIL_W / 2} y={toY(safeNumber(tailLow().prob)) - 3} text-anchor="middle">
    {`${(safeNumber(tailLow().prob) * 100).toFixed(0)}%`}
  </text>
  <text class="distribution-card-axis-label" x={PAD_X + TAIL_W / 2} y={CHART_H - 3} text-anchor="middle">
    {`<${fmtTick(rangeMin())}`}
  </text>
  <Show when={targetU().length === bins().length}>
    <line
      class="distribution-card-target-line"
      x1={PAD_X} x2={PAD_X + TAIL_W}
      y1={toY(targetU()[bins().indexOf(tailLow())])}
      y2={toY(targetU()[bins().indexOf(tailLow())])}
    />
  </Show>
</Show>
<Show when={tailHigh()}>
  <rect
    class="distribution-card-tail-bar"
    x={CHART_W - PAD_X - TAIL_W}
    y={toY(safeNumber(tailHigh().prob))}
    width={TAIL_W}
    height={Math.max(baselineY() - toY(safeNumber(tailHigh().prob)), 0.5)}
  />
  <text class="distribution-card-tail-pct" x={CHART_W - PAD_X - TAIL_W / 2} y={toY(safeNumber(tailHigh().prob)) - 3} text-anchor="middle">
    {`${(safeNumber(tailHigh().prob) * 100).toFixed(0)}%`}
  </text>
  <text class="distribution-card-axis-label" x={CHART_W - PAD_X - TAIL_W / 2} y={CHART_H - 3} text-anchor="middle">
    {`>${fmtTick(rangeMax())}`}
  </text>
  <Show when={targetU().length === bins().length}>
    <line
      class="distribution-card-target-line"
      x1={CHART_W - PAD_X - TAIL_W} x2={CHART_W - PAD_X}
      y1={toY(targetU()[bins().indexOf(tailHigh())])}
      y2={toY(targetU()[bins().indexOf(tailHigh())])}
    />
  </Show>
</Show>
```

Preview overlay: when `quote()?.post_distribution` has `bins().length` entries, add per open tail (inside the same `<Show when={tailLow()}>` / `<Show when={tailHigh()}>` blocks):

```jsx
<Show when={(quote()?.post_distribution || []).length === bins().length}>
  <line
    class="distribution-card-preview-line"
    x1={PAD_X} x2={PAD_X + TAIL_W}  /* tailHigh: x1={CHART_W - PAD_X - TAIL_W} x2={CHART_W - PAD_X} */
    y1={toY(safeNumber(quote().post_distribution[bins().indexOf(tailLow())]))}
    y2={toY(safeNumber(quote().post_distribution[bins().indexOf(tailLow())]))}
  />
</Show>
```

- [ ] **Step 5: CSS** (in the stylesheet that defines `.distribution-card-market-area`, add)

```css
.distribution-card-tail-bar { fill: var(--accent, #4a90d9); opacity: 0.55; }
.distribution-card-tail-pct { font-size: 10px; fill: currentColor; }
.distribution-card-axis-label { font-size: 9px; fill: currentColor; opacity: 0.65; }
```

(Match the file's existing variable/color conventions — if the market-area fill uses a specific var, reuse it.)

- [ ] **Step 6: Delete `fitDistribution` and `quantileFromBins` from `distributionMath.js`** (grep first: DistributionMarketCard was their only consumer).

- [ ] **Step 7: Verify** — FE unit tests still green (`node --test src/utils/distributionMath.test.js`); existing numeric E2E green against the dev stack:

```bash
./tests/e2e/reset-test-users.sh
npx playwright test tests/e2e/numeric-market.spec.js
```
Expected: 4 passed (linear markets must render/trade exactly as before — identity transform).

- [ ] **Step 8: Commit**

```bash
git add frontend-solid/src/components/predictions/DistributionMarketCard.jsx frontend-solid/src/utils/distributionMath.js <stylesheet>
git commit -m "feat(frontend): t-space distribution chart with axis ticks and tail edge bars"
```

---

### Task 9: E2E — log + open market end to end

**Files:**
- Create: `tests/e2e/numeric-open-log-market.spec.js`

**Interfaces:**
- Consumes: everything above, live in the local stack (rebuild the engine first: `docker compose up -d --build prediction-engine`; restart frontend: `docker restart intellacc_frontend_solid`, ~2 min vite build).

- [ ] **Step 1: Write the spec** (model on `tests/e2e/numeric-market.spec.js` — same login flow, psql helper with `-qtAc`, `refundEventStakes` in afterAll)

```js
// E2E: log-scaled, open-bounded numeric market — seeds a 4-bin log market with
// both tails directly in the DB (small bin count keeps the SQL legible; the
// engine validates against config.bin_count + tails, so 4+2=6 outcomes).
// Bins at 10^i: [1,10) [10,100) [100,1000) [1000,10000] + <1 and >10000 tails.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const { refundEventStakes } = require('./helpers/stakeRefund');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';
const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('log-scaled open-tail numeric market', () => {
  let eventId;
  const title = `E2E log-tail market ${Date.now()}`;
  const B = 3466 / Math.log(6);

  test.beforeAll(() => {
    psql(`UPDATE users SET verification_tier = 2 WHERE email = 'user1@example.com'`);
    eventId = Number(psql(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob)
       VALUES ('${title}', 'e2e log seed', NOW() + INTERVAL '7 days', 'numeric', ${1 / 6})
       RETURNING id`
    ));
    // 4 inbound bins at powers of ten + two tails
    const rows = [
      ['bin_0', 'inbound', 1, 10, 0],
      ['bin_1', 'inbound', 10, 100, 1],
      ['bin_2', 'inbound', 100, 1000, 2],
      ['bin_3', 'inbound', 1000, 10000, 3],
      ['tail_low', 'lower_tail', null, 1, 4],
      ['tail_high', 'upper_tail', 10000, null, 5]
    ];
    for (const [key, kind, lo, hi, sort] of rows) {
      const oid = Number(psql(
        `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound, bucket_kind)
         VALUES (${eventId}, '${key}', '${key}', ${sort}, ${lo === null ? 'NULL' : lo}, ${hi === null ? 'NULL' : hi}, '${kind}')
         RETURNING id`
      ));
      psql(
        `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob, updated_at)
         VALUES (${eventId}, ${oid}, 0, ${1 / 6}, NOW())`
      );
    }
    psql(
      `INSERT INTO numeric_market_config
         (event_id, range_min, range_max, zero_point, open_lower_bound, open_upper_bound,
          unit, bin_count, transform, binning_version, b_numeric, numeric_market_version)
       VALUES (${eventId}, 1, 10000, 0, TRUE, TRUE, NULL, 4, 'log', 2, ${B}, 0)`
    );
  });

  test.afterAll(() => {
    if (eventId) {
      refundEventStakes(psql, String(eventId));
      psql(`DELETE FROM events WHERE id = ${eventId}`);
    }
    psql(`UPDATE users SET verification_tier = 1 WHERE email = 'user1@example.com'`);
  });

  test('renders tail bars and log ticks, trades and sells', async ({ page }) => {
    await page.goto(`${BASE}/#login`);
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });

    await page.goto(`${BASE}/#predictions/${eventId}`);
    const card = page.locator('.distribution-market-card');
    await expect(card).toBeVisible({ timeout: 15000 });

    // Both tails render as edge bars, and the axis is log-labeled.
    await expect(card.locator('.distribution-card-tail-bar')).toHaveCount(2);
    await expect(card.locator('.distribution-card-axis-label').filter({ hasText: '<1' })).toHaveCount(1);
    await expect(card.locator('.distribution-card-axis-label').filter({ hasText: '>10K' })).toHaveCount(1);
    await expect(card.locator('.distribution-card-axis-label').filter({ hasText: /^100$/ })).toHaveCount(1);

    // Trade: quote appears within budget, executes, position appears.
    await card.locator('.distribution-card-budget-input').fill('5');
    await expect(card.locator('.distribution-card-quote')).toBeVisible({ timeout: 15000 });
    await card.getByRole('button', { name: /^trade$/i }).click();
    await expect(card.locator('.distribution-card-position')).toBeVisible({ timeout: 15000 });

    // Sell it back; position clears.
    page.on('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: /sell all/i }).click();
    await expect(card.locator('.distribution-card-position')).not.toBeVisible({ timeout: 15000 });
  });
});
```

- [ ] **Step 2: Deploy the branch state locally and run it**

```bash
docker compose up -d --build prediction-engine
docker restart intellacc_frontend_solid && sleep 150
./tests/e2e/reset-test-users.sh
npx playwright test tests/e2e/numeric-open-log-market.spec.js
```
Expected: 1 passed. If the tick assertions fail on formatting (`10K` vs `10k`), fix the assertion to match `Intl.NumberFormat('en', {notation:'compact'})` output — do not change the formatter.

- [ ] **Step 3: Full E2E regression sweep**

```bash
npx playwright test tests/e2e/market-detail.spec.js tests/e2e/multi-outcome-trading.spec.js tests/e2e/my-positions-section.spec.js tests/e2e/numeric-market.spec.js tests/e2e/numeric-open-log-market.spec.js tests/e2e/community-group-markets.spec.js
```
Expected: all passed (17).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/numeric-open-log-market.spec.js
git commit -m "test(e2e): log-scaled open-tail numeric market trades end to end"
```

---

### Task 10: Ship — gates, deploy, prod seed, docs

**Files:**
- Modify: `docs/ops/numeric-market-resolution.md` (tails note), memory file (controller does this outside the task if executing via subagents)

- [ ] **Step 1: Full gates**

```bash
./scripts/test_prediction_engine.sh --full          # container exit 0
./tests/e2e/reset-test-users.sh && npx playwright test tests/e2e/market-detail.spec.js tests/e2e/multi-outcome-trading.spec.js tests/e2e/my-positions-section.spec.js tests/e2e/numeric-market.spec.js tests/e2e/numeric-open-log-market.spec.js tests/e2e/community-group-markets.spec.js
```

- [ ] **Step 2: Push and watch CI**

```bash
git push origin master
gh run list --limit 2   # then gh run watch <id> --exit-status for both workflows
```

- [ ] **Step 3: Deploy** (already-approved deploy actions)

```bash
docker restart intellacc_backend        # migration (no-op if Task 1 already applied it)
docker compose up -d --build prediction-engine
docker restart intellacc_frontend_solid # ~2 min vite build
```

- [ ] **Step 4: Seed real markets + verify on prod**

```bash
# trigger a Metaculus sync (x-engine-token from prediction-engine/.env)
docker exec intellacc_backend node -e "
fetch('http://prediction-engine:3001/imports/sync/metaculus', {
  method: 'POST',
  headers: { 'x-engine-token': process.env.PREDICTION_ENGINE_AUTH_TOKEN }
}).then(r => r.json()).then(j => console.log(JSON.stringify(j)))"

docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c \
  "SELECT transform, open_lower_bound, open_upper_bound, COUNT(*) FROM numeric_market_config GROUP BY 1,2,3"
```
Expected: rows with `transform='log'` and/or open flags TRUE appear. Open one such market at https://intellacc.de (find its id via `SELECT event_id FROM numeric_market_config WHERE transform='log' LIMIT 1`, then `#predictions/<id>`): chart renders with log ticks; tails show as edge bars; a small quote loads.

- [ ] **Step 5: Runbook note** — in `docs/ops/numeric-market-resolution.md` §2 ("Find the true outcome"), add:

```markdown
Open-bounded markets (config `open_lower_bound`/`open_upper_bound`) have
`tail_low`/`tail_high` outcomes: a resolved value below/above the range
settles into the tail automatically — `PATCH` with the actual
`numerical_outcome` value as usual, never clamp it into the range.
```

- [ ] **Step 6: Commit + push docs**

```bash
git add docs/ops/numeric-market-resolution.md
git commit -m "docs(ops): tail-outcome note for open-bounded numeric resolutions"
git push origin master
```
