//! Integration tests for LMSR API/DB layer
//!
//! These tests verify the complete API/database flow including:
//! - buy YES, buy NO, sell partial YES, sell partial NO, resolve YES
//! - All financial invariants are maintained
//! - High load and repeated scenarios
//! - Concurrency safety

use crate::config::Config;
use crate::lmsr_api;
use crate::lmsr_api::MarketUpdate;
use crate::lmsr_core::{to_ledger_units, Side};
use anyhow::{anyhow, Result};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Test database configuration for isolated testing
const DEFAULT_TEST_DB_URL: &str = "postgresql://postgres:password@localhost:5432/test_intellacc";
const DEFAULT_TEST_DB_ADMIN_URL: &str = "postgresql://postgres:password@localhost:5432/postgres";

fn test_db_url() -> String {
    env::var("TEST_DB_URL").unwrap_or_else(|_| DEFAULT_TEST_DB_URL.to_string())
}

fn test_db_admin_url() -> String {
    env::var("TEST_DB_ADMIN_URL").unwrap_or_else(|_| DEFAULT_TEST_DB_ADMIN_URL.to_string())
}

fn test_db_url_for(db_name: &str) -> String {
    test_db_url().replace("/test_intellacc", &format!("/{}", db_name))
}

fn unique_test_db_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("test_intellacc_{}_{}", ts, counter)
}

fn test_config() -> Config {
    let mut config = Config::default();
    config.market.enable_hold_period = false;
    config.market.hold_period_hours = 0.0;
    config
}

fn env_usize(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_i64(name: &str, default: i64) -> i64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(default)
}

fn env_f64(name: &str, default: f64) -> f64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

fn env_f64_clamped(name: &str, default: f64, min: f64, max: f64) -> f64 {
    env_f64(name, default).clamp(min, max)
}

fn to_ledger_i64(value: f64) -> Result<i64> {
    let ledger = to_ledger_units(value).map_err(|e| anyhow!(e))?;
    i64::try_from(ledger).map_err(|_| anyhow!("ledger value out of i64 range"))
}

/// Initial user balance for tests (1000 RP in ledger units)
const INITIAL_BALANCE_LEDGER: i64 = 1_000_000_000; // 1000 * 1_000_000

/// Test configuration constants
const STRESS_TEST_USERS: usize = 12;
const STRESS_TEST_OPERATIONS: usize = 500;
const STRESS_TEST_ITERATIONS: usize = 5;

/// Test user data structure
#[derive(Debug, Clone)]
struct TestUser {
    id: i32,
}

/// Market operation result for tracking
#[derive(Debug)]
struct OperationResult {
    user_id: i32,
    balance_change: i64,
    staked_change: i64,
}

struct TestDatabase {
    pool: PgPool,
    db_name: String,
}

async fn fetch_user_ledger(pool: &PgPool, user_id: i32) -> Result<(i64, i64)> {
    let row = sqlx::query("SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await?;

    Ok((row.get("rp_balance_ledger"), row.get("rp_staked_ledger")))
}

async fn build_operation_result(
    pool: &PgPool,
    user_id: i32,
    before_balance: i64,
    before_staked: i64,
) -> Result<OperationResult> {
    let (after_balance, after_staked) = fetch_user_ledger(pool, user_id).await?;
    let balance_change = after_balance - before_balance;
    let staked_change = after_staked - before_staked;

    Ok(OperationResult {
        user_id,
        balance_change,
        staked_change,
    })
}

/// Setup test database with clean state
async fn setup_test_database() -> Result<TestDatabase> {
    println!("🔧 Setting up test database...");
    let db_name = unique_test_db_name();

    // Connect to default postgres database first
    let admin_url = test_db_admin_url();
    let setup_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&admin_url)
        .await?;

    sqlx::query(&format!("CREATE DATABASE {}", db_name))
        .execute(&setup_pool)
        .await?;

    setup_pool.close().await;

    // Connect to test database
    let test_url = test_db_url_for(&db_name);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(&test_url)
        .await?;

    // Run migrations
    run_test_migrations(&pool).await?;

    println!("✅ Test database ready");
    Ok(TestDatabase { pool, db_name })
}

/// Run essential migrations for testing
async fn run_test_migrations(pool: &PgPool) -> Result<()> {
    // Create users table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL DEFAULT 'test_hash',
            rp_balance_ledger BIGINT DEFAULT 1000000000,
            rp_staked_ledger BIGINT DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            CONSTRAINT rp_balance_ledger_non_negative CHECK (rp_balance_ledger >= 0),
            CONSTRAINT rp_staked_ledger_non_negative CHECK (rp_staked_ledger >= 0)
        )
    "#,
    )
    .execute(pool)
    .await?;

    // Create events table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS events (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            outcome VARCHAR(50),
            closing_date TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            market_prob DOUBLE PRECISION DEFAULT 0.5,
            liquidity_b DOUBLE PRECISION DEFAULT 100.0,
            q_yes DOUBLE PRECISION DEFAULT 0.0,
            q_no DOUBLE PRECISION DEFAULT 0.0,
            cumulative_stake DOUBLE PRECISION DEFAULT 0.0,
            event_type VARCHAR(32) NOT NULL DEFAULT 'binary',
            resolved_at TIMESTAMP WITH TIME ZONE,
            numerical_outcome DECIMAL(15,6),
            resolution_outcome_id BIGINT
        )
    "#,
    )
    .execute(pool)
    .await?;

    // Create user_shares table
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS user_shares (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            yes_shares DOUBLE PRECISION DEFAULT 0 CHECK (yes_shares >= 0),
            no_shares DOUBLE PRECISION DEFAULT 0 CHECK (no_shares >= 0),
            total_staked_ledger BIGINT DEFAULT 0,
            staked_yes_ledger BIGINT NOT NULL DEFAULT 0,
            staked_no_ledger BIGINT NOT NULL DEFAULT 0,
            realized_pnl_ledger BIGINT DEFAULT 0,
            version INTEGER DEFAULT 1,
            last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(user_id, event_id),
            CONSTRAINT user_shares_total_staked_non_negative CHECK (total_staked_ledger >= 0),
            CONSTRAINT user_shares_staked_yes_nonnegative CHECK (staked_yes_ledger >= 0),
            CONSTRAINT user_shares_staked_no_nonnegative CHECK (staked_no_ledger >= 0),
            CONSTRAINT user_shares_stake_consistency CHECK (total_staked_ledger = (staked_yes_ledger + staked_no_ledger)),
            CONSTRAINT user_shares_version_positive CHECK (version > 0)
        )
    "#).execute(pool).await?;

    // Create market_updates table for audit trail
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS market_updates (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            event_id INTEGER NOT NULL REFERENCES events(id),
            prev_prob DOUBLE PRECISION NOT NULL,
            new_prob DOUBLE PRECISION NOT NULL,
            stake_amount DOUBLE PRECISION NOT NULL CHECK (stake_amount > 0),
            stake_amount_ledger BIGINT NOT NULL DEFAULT 0 CHECK (stake_amount_ledger >= 0),
            shares_acquired DOUBLE PRECISION NOT NULL CHECK (shares_acquired > 0),
            share_type VARCHAR(10) NOT NULL CHECK (share_type IN ('yes', 'no')),
            referral_post_id INTEGER,
            referral_click_id INTEGER,
            had_prior_position BOOLEAN NOT NULL DEFAULT FALSE,
            hold_until TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
    "#,
    )
    .execute(pool)
    .await?;

    // Minimal stand-ins for the multi-outcome / numeric-market tables the
    // backend migrations create in every real environment. The resolve and
    // trade guards (ensure_not_numeric_market / ensure_not_multi_outcome_market)
    // query these; without the tables those queries error and every binary
    // resolve fails. Empty tables = "not numeric, not multi-outcome".
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS event_outcomes (
            id BIGSERIAL PRIMARY KEY,
            event_id INTEGER NOT NULL REFERENCES events(id),
            outcome_key TEXT NOT NULL,
            label TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            lower_bound DOUBLE PRECISION,
            upper_bound DOUBLE PRECISION,
            bucket_kind TEXT NOT NULL DEFAULT 'inbound',
            is_active BOOLEAN NOT NULL DEFAULT TRUE
        )
    "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS numeric_market_config (
            event_id INTEGER PRIMARY KEY REFERENCES events(id),
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
        )
    "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS market_outcome_updates (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
            prev_prob DOUBLE PRECISION NOT NULL,
            new_prob DOUBLE PRECISION NOT NULL,
            stake_amount DOUBLE PRECISION NOT NULL CHECK (stake_amount > 0),
            stake_amount_ledger BIGINT NOT NULL DEFAULT 0 CHECK (stake_amount_ledger >= 0),
            shares_acquired DOUBLE PRECISION NOT NULL CHECK (shares_acquired > 0),
            hold_until TIMESTAMPTZ NOT NULL,
            referral_post_id INTEGER,
            referral_click_id INTEGER,
            had_prior_position BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    "#,
    )
    .execute(pool)
    .await?;

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

    // Stand-ins for the per-outcome / numeric-position ledger tables the
    // post-resolution invariant (verify_post_resolution_invariant_transaction)
    // checks in every real environment. Mirrors production minus indexes.
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

    Ok(())
}

/// Create test users with initial balances
async fn create_test_users(pool: &PgPool, count: usize) -> Result<Vec<TestUser>> {
    let mut users = Vec::new();

    for i in 0..count {
        let username = format!("testuser_{}", i);
        let email = format!("test{}@example.com", i);

        let user_id: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email, rp_balance_ledger, rp_staked_ledger) 
             VALUES ($1, $2, $3, 0) RETURNING id",
        )
        .bind(&username)
        .bind(&email)
        .bind(INITIAL_BALANCE_LEDGER)
        .fetch_one(pool)
        .await?;

        users.push(TestUser { id: user_id });
    }

    println!("✅ Created {} test users", count);
    Ok(users)
}

/// Create test event
async fn create_test_event(pool: &PgPool, title: &str) -> Result<i32> {
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, description, closing_date, liquidity_b, event_type) 
         VALUES ($1, $2, NOW() + INTERVAL '7 days', 100.0, 'binary') RETURNING id",
    )
    .bind(title)
    .bind("Integration test event")
    .fetch_one(pool)
    .await?;

    Ok(event_id)
}

/// Capture initial system state for invariant checking
async fn capture_initial_state(pool: &PgPool) -> Result<HashMap<i32, (i64, i64)>> {
    let rows = sqlx::query("SELECT id, rp_balance_ledger, rp_staked_ledger FROM users")
        .fetch_all(pool)
        .await?;

    let mut initial_state = HashMap::new();
    for row in rows {
        let user_id: i32 = row.get("id");
        let balance: i64 = row.get("rp_balance_ledger");
        let staked: i64 = row.get("rp_staked_ledger");
        initial_state.insert(user_id, (balance, staked));
    }

    Ok(initial_state)
}

/// Verify primary financial invariant: users.rp_balance_ledger + users.rp_staked_ledger == initial + Σ(ledger ΔC) + Σ(resolution credits)
async fn verify_balance_invariant(
    pool: &PgPool,
    initial_state: &HashMap<i32, (i64, i64)>,
    operations: &[OperationResult],
    resolution_credits: &HashMap<i32, i64>,
) -> Result<()> {
    let current_state = sqlx::query("SELECT id, rp_balance_ledger, rp_staked_ledger FROM users")
        .fetch_all(pool)
        .await?;

    for row in current_state {
        let user_id: i32 = row.get("id");
        let current_balance: i64 = row.get("rp_balance_ledger");
        let current_staked: i64 = row.get("rp_staked_ledger");

        let (initial_balance, initial_staked) = initial_state.get(&user_id).unwrap_or(&(0, 0));
        let initial_total = initial_balance + initial_staked;
        let current_total = current_balance + current_staked;

        // Calculate expected total based on operations
        let operation_changes: i64 = operations
            .iter()
            .filter(|op| op.user_id == user_id)
            .map(|op| op.balance_change + op.staked_change)
            .sum();

        let resolution_credit = resolution_credits.get(&user_id).unwrap_or(&0);
        let expected_total = initial_total + operation_changes + resolution_credit;

        if current_total != expected_total {
            return Err(anyhow!(
                "Balance invariant violation for user {}: expected {}, got {} (diff: {})",
                user_id,
                expected_total,
                current_total,
                current_total - expected_total
            ));
        }
    }

    println!("✅ Balance invariant verified for all users");
    Ok(())
}

/// Verify staked consistency: users.rp_staked_ledger == Σ user_shares.total_staked_ledger (before resolution)
async fn verify_staked_invariant(pool: &PgPool) -> Result<()> {
    let user_staked = sqlx::query("SELECT id, rp_staked_ledger FROM users ORDER BY id")
        .fetch_all(pool)
        .await?;

    for row in user_staked {
        let user_id: i32 = row.get("id");
        let user_staked_ledger: i64 = row.get("rp_staked_ledger");

        let total_shares_staked: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(total_staked_ledger), 0)::BIGINT
             FROM user_shares WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;

        if user_staked_ledger != total_shares_staked {
            return Err(anyhow!(
                "Staked invariant violation for user {}: user.rp_staked_ledger={}, Σ(user_shares.total_staked_ledger)={}",
                user_id, user_staked_ledger, total_shares_staked
            ));
        }
    }

    println!("✅ Staked invariant verified for all users");
    Ok(())
}

/// Verify post-resolution invariant: user_shares rows cleared; rp_staked_ledger unchanged by further reads
async fn verify_post_resolution_invariant(pool: &PgPool, event_id: i32) -> Result<()> {
    // Check that user_shares rows are cleared for the resolved event
    let remaining_shares: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_shares WHERE event_id = $1")
            .bind(event_id)
            .fetch_one(pool)
            .await?;

    if remaining_shares != 0 {
        return Err(anyhow!(
            "Post-resolution invariant violation: {} user_shares rows remain for event {}",
            remaining_shares,
            event_id
        ));
    }

    // resolved_at must be stamped in the same transaction that settles the market
    let resolved_stamped: bool =
        sqlx::query_scalar("SELECT resolved_at IS NOT NULL FROM events WHERE id = $1")
            .bind(event_id)
            .fetch_one(pool)
            .await?;
    if !resolved_stamped {
        return Err(anyhow!(
            "Post-resolution invariant violation: resolved_at not stamped for event {}",
            event_id
        ));
    }

    // Verify that subsequent reads don't modify rp_staked
    let staked_before = sqlx::query("SELECT id, rp_staked_ledger FROM users ORDER BY id")
        .fetch_all(pool)
        .await?;

    // Perform some read operations
    let _market_state = sqlx::query("SELECT market_prob, liquidity_b FROM events WHERE id = $1")
        .bind(event_id)
        .fetch_optional(pool)
        .await?;

    let _user_balances = sqlx::query("SELECT rp_balance_ledger, rp_staked_ledger FROM users")
        .fetch_all(pool)
        .await?;

    let staked_after = sqlx::query("SELECT id, rp_staked_ledger FROM users ORDER BY id")
        .fetch_all(pool)
        .await?;

    // Verify no changes in rp_staked
    if staked_before.len() != staked_after.len() {
        return Err(anyhow!("User count changed during read operations"));
    }

    for (before, after) in staked_before.iter().zip(staked_after.iter()) {
        let user_id_before: i32 = before.get("id");
        let user_id_after: i32 = after.get("id");
        let staked_before: i64 = before.get("rp_staked_ledger");
        let staked_after: i64 = after.get("rp_staked_ledger");

        if user_id_before != user_id_after || staked_before != staked_after {
            return Err(anyhow!(
                "Post-resolution invariant violation: rp_staked changed during reads for user {}",
                user_id_before
            ));
        }
    }

    println!("✅ Post-resolution invariant verified");
    Ok(())
}

/// Cleanup test database
async fn cleanup_test_database(pool: PgPool, db_name: &str) -> Result<()> {
    pool.close().await;

    let cleanup_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&test_db_admin_url())
        .await?;

    sqlx::query(&format!("DROP DATABASE IF EXISTS {}", db_name))
        .execute(&cleanup_pool)
        .await
        .ok(); // Ignore errors

    cleanup_pool.close().await;
    println!("🧹 Test database cleaned up");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Single user market cycle test
    #[tokio::test]
    async fn test_single_user_market_cycle() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;
        let users = create_test_users(pool, 1).await?;
        let user = &users[0];
        let event_id = create_test_event(pool, "Single User Test Event").await?;
        let config = test_config();

        let initial_state = capture_initial_state(pool).await?;
        let mut operations = Vec::new();
        let mut resolution_credits = HashMap::new();

        println!("🧪 Starting single user market cycle test...");

        // Buy YES shares
        println!("📈 Buying YES shares...");
        let stake1 = 50.0; // 50 RP
        let (before_balance, before_staked) = fetch_user_ledger(pool, user.id).await?;
        let _ = lmsr_api::update_market(
            pool,
            &config,
            user.id,
            MarketUpdate {
                event_id,
                target_prob: 0.7,
                stake: stake1,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await?;

        operations
            .push(build_operation_result(pool, user.id, before_balance, before_staked).await?);

        // Verify invariants after buy YES
        verify_balance_invariant(pool, &initial_state, &operations, &resolution_credits).await?;
        verify_staked_invariant(pool).await?;

        // Buy NO shares
        println!("📉 Buying NO shares...");
        let stake2 = 30.0; // 30 RP
        let (before_balance, before_staked) = fetch_user_ledger(pool, user.id).await?;
        let _ = lmsr_api::update_market(
            pool,
            &config,
            user.id,
            MarketUpdate {
                event_id,
                target_prob: 0.4,
                stake: stake2,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await?;

        operations
            .push(build_operation_result(pool, user.id, before_balance, before_staked).await?);

        // Verify invariants after buy NO
        verify_balance_invariant(pool, &initial_state, &operations, &resolution_credits).await?;
        verify_staked_invariant(pool).await?;

        // Get current user shares for partial selling
        let user_shares = sqlx::query(
            "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2",
        )
        .bind(user.id)
        .bind(event_id)
        .fetch_one(pool)
        .await?;

        let yes_shares: f64 = user_shares.get("yes_shares");
        let no_shares: f64 = user_shares.get("no_shares");

        // Sell partial YES shares
        if yes_shares > 0.0 {
            println!("💰 Selling partial YES shares...");
            let sell_amount = yes_shares * 0.3; // Sell 30% of YES shares
            let (before_balance, before_staked) = fetch_user_ledger(pool, user.id).await?;
            let _sell_yes_result = lmsr_api::sell_shares(
                pool,
                &config,
                user.id,
                event_id,
                Side::Yes.as_str(),
                sell_amount,
            )
            .await?;

            operations
                .push(build_operation_result(pool, user.id, before_balance, before_staked).await?);

            // Verify invariants after sell YES
            verify_balance_invariant(pool, &initial_state, &operations, &resolution_credits)
                .await?;
            verify_staked_invariant(pool).await?;
        }

        // Sell partial NO shares
        if no_shares > 0.0 {
            println!("💰 Selling partial NO shares...");
            let sell_amount = no_shares * 0.5; // Sell 50% of NO shares
            let (before_balance, before_staked) = fetch_user_ledger(pool, user.id).await?;
            let _sell_no_result = lmsr_api::sell_shares(
                pool,
                &config,
                user.id,
                event_id,
                Side::No.as_str(),
                sell_amount,
            )
            .await?;

            operations
                .push(build_operation_result(pool, user.id, before_balance, before_staked).await?);

            // Verify invariants after sell NO
            verify_balance_invariant(pool, &initial_state, &operations, &resolution_credits)
                .await?;
            verify_staked_invariant(pool).await?;
        }

        // Resolve YES
        println!("🎯 Resolving event as YES...");

        // Calculate resolution credits before resolution
        let final_shares = sqlx::query(
                "SELECT yes_shares, staked_yes_ledger, staked_no_ledger FROM user_shares WHERE user_id = $1 AND event_id = $2",
            )
            .bind(user.id)
            .bind(event_id)
            .fetch_optional(pool)
            .await?;

        if let Some(shares_row) = final_shares {
            let final_yes_shares: f64 = shares_row.get("yes_shares");
            let staked_yes_ledger: i64 = shares_row.get("staked_yes_ledger");
            let staked_no_ledger: i64 = shares_row.get("staked_no_ledger");
            let total_staked_ledger = staked_yes_ledger + staked_no_ledger;

            // Net payout includes share value minus remaining staked ledger balance cleared at resolution.
            let payout_ledger = to_ledger_i64(final_yes_shares)?
                .checked_sub(total_staked_ledger)
                .ok_or_else(|| anyhow!("Resolution payout underflow for user {}", user.id))?;
            resolution_credits.insert(user.id, payout_ledger);
        }

        lmsr_api::resolve_event(pool, event_id, true).await?;

        // Verify all invariants after resolution
        verify_balance_invariant(pool, &initial_state, &operations, &resolution_credits).await?;
        verify_post_resolution_invariant(pool, event_id).await?;

        println!("✅ Single user market cycle test PASSED");
        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

    /// Multi-user stress test with concurrent operations
    #[tokio::test]
    async fn test_multi_user_stress() -> Result<()> {
        for iteration in 0..STRESS_TEST_ITERATIONS {
            println!(
                "🔥 Stress test iteration {}/{}",
                iteration + 1,
                STRESS_TEST_ITERATIONS
            );

            let test_db = setup_test_database().await?;
            let pool = &test_db.pool;
            let users = create_test_users(pool, STRESS_TEST_USERS).await?;
            let event_id =
                create_test_event(pool, &format!("Stress Test Event {}", iteration)).await?;
            let config = test_config();

            let initial_state = capture_initial_state(pool).await?;
            let mut operations = Vec::new();
            let mut rng = rand::thread_rng();

            println!(
                "⚡ Executing {} random operations...",
                STRESS_TEST_OPERATIONS
            );

            // Execute random operations
            for op_idx in 0..STRESS_TEST_OPERATIONS {
                let user = &users[rng.gen_range(0..users.len())];
                let operation_type = rng.gen_range(0..4); // 0=buy_yes, 1=buy_no, 2=sell_yes, 3=sell_no

                match operation_type {
                    0 | 1 => {
                        // Buy operation
                        let stake = rng.gen_range(1.0..20.0); // 1-20 RP
                        let target_prob = if operation_type == 0 {
                            rng.gen_range(0.55..0.95) // Buy YES - push prob up
                        } else {
                            rng.gen_range(0.05..0.45) // Buy NO - push prob down
                        };

                        let (before_balance, before_staked) =
                            fetch_user_ledger(pool, user.id).await?;
                        match lmsr_api::update_market(
                            pool,
                            &config,
                            user.id,
                            MarketUpdate {
                                event_id,
                                target_prob,
                                stake,
                                referral_post_id: None,
                                referral_click_id: None,
                            },
                        )
                        .await
                        {
                            Ok(_) => {
                                operations.push(
                                    build_operation_result(
                                        pool,
                                        user.id,
                                        before_balance,
                                        before_staked,
                                    )
                                    .await?,
                                );
                            }
                            Err(_) => {
                                // Expected for some operations (insufficient balance, etc.)
                                continue;
                            }
                        }
                    }
                    2 | 3 => {
                        // Sell operation - only if user has shares
                        let user_shares_result = sqlx::query(
                            "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2"
                        )
                        .bind(user.id)
                        .bind(event_id)
                        .fetch_optional(pool)
                        .await?;

                        if let Some(shares_row) = user_shares_result {
                            let yes_shares: f64 = shares_row.get("yes_shares");
                            let no_shares: f64 = shares_row.get("no_shares");

                            let (side, available_shares) = if operation_type == 2 {
                                (Side::Yes, yes_shares)
                            } else {
                                (Side::No, no_shares)
                            };

                            if available_shares > 0.01 {
                                let sell_amount = available_shares * rng.gen_range(0.1..0.8);
                                let (before_balance, before_staked) =
                                    fetch_user_ledger(pool, user.id).await?;

                                match lmsr_api::sell_shares(
                                    pool,
                                    &config,
                                    user.id,
                                    event_id,
                                    side.as_str(),
                                    sell_amount,
                                )
                                .await
                                {
                                    Ok(result) => {
                                        let _ = result;
                                        operations.push(
                                            build_operation_result(
                                                pool,
                                                user.id,
                                                before_balance,
                                                before_staked,
                                            )
                                            .await?,
                                        );
                                    }
                                    Err(_) => {
                                        // Expected for some operations
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                    _ => unreachable!(),
                }

                // Verify invariants periodically
                if op_idx % 100 == 0 {
                    verify_staked_invariant(pool).await?;
                }
            }

            println!(
                "📊 Completed {} operations, verifying final invariants...",
                operations.len()
            );

            // Final invariant verification before resolution
            let empty_resolution_credits = HashMap::new();
            verify_balance_invariant(
                pool,
                &initial_state,
                &operations,
                &empty_resolution_credits,
            )
            .await?;
            verify_staked_invariant(pool).await?;

            // Calculate resolution credits
            let mut resolution_credits = HashMap::new();
            let all_shares = sqlx::query(
                "SELECT user_id, yes_shares, no_shares, staked_yes_ledger, staked_no_ledger FROM user_shares WHERE event_id = $1",
            )
            .bind(event_id)
            .fetch_all(pool)
            .await?;

            let outcome = rng.gen_bool(0.5); // Random resolution outcome
            for shares_row in all_shares {
                let user_id: i32 = shares_row.get("user_id");
                let yes_shares: f64 = shares_row.get("yes_shares");
                let no_shares: f64 = shares_row.get("no_shares");

                let resolution_value = if outcome {
                    yes_shares // YES outcome
                } else {
                    no_shares // NO outcome
                };
                let total_staked_ledger = shares_row.get::<i64, _>("staked_yes_ledger")
                    + shares_row.get::<i64, _>("staked_no_ledger");
                let payout_ledger = to_ledger_i64(resolution_value)?
                    .checked_sub(total_staked_ledger)
                    .ok_or_else(|| anyhow!("Resolution payout underflow for user {}", user_id))?;
                resolution_credits.insert(user_id, payout_ledger);
            }

            // Resolve event
            lmsr_api::resolve_event(pool, event_id, outcome).await?;

            // Final verification
            verify_balance_invariant(pool, &initial_state, &operations, &resolution_credits)
                .await?;
            verify_post_resolution_invariant(pool, event_id).await?;

            cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        }

        println!(
            "✅ Multi-user stress test PASSED ({} iterations)",
            STRESS_TEST_ITERATIONS
        );
        Ok(())
    }

    /// Edge case tests: zero balance, max stake, insufficient funds, etc.
    #[tokio::test]
    async fn test_edge_cases() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;
        let users = create_test_users(pool, 3).await?;
        let event_id = create_test_event(pool, "Edge Case Test Event").await?;
        let config = test_config();

        println!("🧪 Starting edge case tests...");

        // Test 1: Zero balance user trying to buy shares
        println!("📉 Test 1: Zero balance user attempting trade");

        // Set user balance to zero
        sqlx::query("UPDATE users SET rp_balance_ledger = 0, rp_staked_ledger = 0 WHERE id = $1")
            .bind(users[0].id)
            .execute(pool)
            .await?;

        let zero_balance_result = lmsr_api::update_market(
            pool,
            &config,
            users[0].id,
            MarketUpdate {
                event_id,
                target_prob: 0.7,
                stake: 100.0,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await;

        assert!(
            zero_balance_result.is_err(),
            "Zero balance user should not be able to trade"
        );
        println!("✅ Zero balance user correctly rejected");

        // Test 2: Maximum stake amount (should hit overflow protection)
        println!("💥 Test 2: Maximum stake amount test");
        let max_stake_result = lmsr_api::update_market(
            pool,
            &config,
            users[1].id,
            MarketUpdate {
                event_id,
                target_prob: 0.9,
                stake: 1_000_000.0, // Very large stake
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await;

        // This should either succeed with limited impact or fail gracefully
        match max_stake_result {
            Ok(_) => println!("✅ Large stake handled gracefully"),
            Err(e) => println!("✅ Large stake rejected: {}", e),
        }

        // Test 3: Selling more shares than owned
        println!("🚫 Test 3: Overselling shares test");

        // First, give user some shares
        let buy_result = lmsr_api::update_market(
            pool,
            &config,
            users[2].id,
            MarketUpdate {
                event_id,
                target_prob: 0.6,
                stake: 50.0,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await?;

        // Try to sell more than owned
        let oversell_result = lmsr_api::sell_shares(
            pool,
            &config,
            users[2].id,
            event_id,
            Side::Yes.as_str(),
            buy_result.shares_acquired * 2.0, // Try to sell double what we own
        )
        .await;

        assert!(
            oversell_result.is_err(),
            "Should not be able to oversell shares"
        );
        println!("✅ Overselling correctly rejected");

        // Test 4: Concurrent transactions (race condition test)
        println!("🏃 Test 4: Concurrent transaction test");

        let futures = (0..10).map(|_| {
            lmsr_api::update_market(
                pool,
                &config,
                users[1].id,
                MarketUpdate {
                    event_id,
                    target_prob: 0.55,
                    stake: 10.0,
                    referral_post_id: None,
                    referral_click_id: None,
                },
            )
        });

        let results = futures_util::future::join_all(futures).await;
        let successful_trades = results.iter().filter(|r| r.is_ok()).count();

        println!(
            "✅ Concurrent transactions: {}/10 succeeded",
            successful_trades
        );

        // Test 5: Invalid probability bounds
        println!("📊 Test 5: Invalid probability bounds test");

        let invalid_prob_high = lmsr_api::update_market(
            pool,
            &config,
            users[1].id,
            MarketUpdate {
                event_id,
                target_prob: 1.5, // Invalid: > 1.0
                stake: 10.0,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await;

        let invalid_prob_low = lmsr_api::update_market(
            pool,
            &config,
            users[1].id,
            MarketUpdate {
                event_id,
                target_prob: -0.1, // Invalid: < 0.0
                stake: 10.0,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await;

        assert!(
            invalid_prob_high.is_err(),
            "Probability > 1.0 should be rejected"
        );
        assert!(
            invalid_prob_low.is_err(),
            "Probability < 0.0 should be rejected"
        );
        println!("✅ Invalid probabilities correctly rejected");

        // Test 6: Post-resolution trading attempts
        println!("🔒 Test 6: Closed-market trading test");

        // Move closing date to the past
        sqlx::query("UPDATE events SET closing_date = NOW() - INTERVAL '1 minute' WHERE id = $1")
            .bind(event_id)
            .execute(pool)
            .await?;

        let closed_market_trade = lmsr_api::update_market(
            pool,
            &config,
            users[1].id,
            MarketUpdate {
                event_id,
                target_prob: 0.7,
                stake: 20.0,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await;

        assert!(
            closed_market_trade.is_err(),
            "Trading on closed event should be rejected"
        );

        let closed_err = closed_market_trade
            .err()
            .expect("Expected closed market update error");
        assert!(
            closed_err.to_string().contains("Market closed"),
            "Expected 'Market closed' error, got: {closed_err}"
        );
        println!("✅ Closed-market trading correctly rejected");

        // Test 7: Post-resolution trading attempts
        println!("🎯 Test 7: Post-resolution trading test");

        // Re-open market before resolving so resolved-state error is tested distinctly
        sqlx::query("UPDATE events SET closing_date = NOW() + INTERVAL '7 days' WHERE id = $1")
            .bind(event_id)
            .execute(pool)
            .await?;

        // Resolve the event
        lmsr_api::resolve_event(pool, event_id, true).await?;

        // Try to trade on resolved event
        let post_resolution_trade = lmsr_api::update_market(
            pool,
            &config,
            users[1].id,
            MarketUpdate {
                event_id,
                target_prob: 0.7,
                stake: 20.0,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await;

        assert!(
            post_resolution_trade.is_err(),
            "Trading on resolved event should be rejected"
        );
        let resolved_trade_err = post_resolution_trade
            .err()
            .expect("Expected resolved market update error");
        assert!(
            resolved_trade_err.to_string().contains("Market resolved"),
            "Expected 'Market resolved' error, got: {resolved_trade_err}"
        );
        println!("✅ Post-resolution trading correctly rejected");

        // Test 8: Database consistency under failures
        println!("🔗 Test 8: Database consistency test");

        // Create new event for this test
        let consistency_event_id = create_test_event(pool, "Consistency Test").await?;

        // Perform a transaction and verify all tables are consistent
        let trade_result = lmsr_api::update_market(
            pool,
            &config,
            users[1].id,
            MarketUpdate {
                event_id: consistency_event_id,
                target_prob: 0.65,
                stake: 25.0,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await?;
        let _ = trade_result;

        // Verify data consistency across all tables
        let user_balance: i64 =
            sqlx::query_scalar("SELECT rp_balance_ledger FROM users WHERE id = $1")
                .bind(users[1].id)
                .fetch_one(pool)
                .await?;

        let user_staked: i64 =
            sqlx::query_scalar("SELECT rp_staked_ledger FROM users WHERE id = $1")
                .bind(users[1].id)
                .fetch_one(pool)
                .await?;

        let shares_staked: Option<i64> = sqlx::query_scalar(
            "SELECT total_staked_ledger FROM user_shares WHERE user_id = $1 AND event_id = $2",
        )
        .bind(users[1].id)
        .bind(consistency_event_id)
        .fetch_optional(pool)
        .await?;

        let audit_trail_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM market_updates WHERE user_id = $1 AND event_id = $2",
        )
        .bind(users[1].id)
        .bind(consistency_event_id)
        .fetch_one(pool)
        .await?;

        assert!(user_balance >= 0, "User balance should be non-negative");
        assert!(user_staked >= 0, "User staked should be non-negative");
        assert!(
            shares_staked.unwrap_or(0) > 0,
            "User should have shares after trade"
        );
        assert!(
            audit_trail_count > 0,
            "Audit trail should record the transaction"
        );

        println!("✅ Database consistency verified");

        println!("✅ All edge case tests PASSED");
        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

    /// Boundary condition tests for numerical precision
    #[tokio::test]
    async fn test_numerical_precision() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;
        let users = create_test_users(pool, 1).await?;
        let event_id = create_test_event(pool, "Precision Test Event").await?;
        let config = test_config();

        println!("🔢 Starting numerical precision tests...");

        // Test 1: Very small stakes (micro-RP precision)
        println!("🔬 Test 1: Micro-RP precision test");

        let micro_stake = 0.000001; // 1 micro-RP
        let micro_result = lmsr_api::update_market(
            pool,
            &config,
            users[0].id,
            MarketUpdate {
                event_id,
                target_prob: 0.50001, // Very small probability change
                stake: micro_stake,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await;

        match micro_result {
            Ok(result) => {
                assert!(
                    result.shares_acquired > 0.0,
                    "Should acquire some shares even with micro-stake"
                );
                println!(
                    "✅ Micro-stake handled: {} shares acquired",
                    result.shares_acquired
                );
            }
            Err(e) => println!("✅ Micro-stake rejected (acceptable): {}", e),
        }

        // Test 2: Precision boundary at probability extremes
        println!("⚡ Test 2: Extreme probability precision");

        let extreme_prob_tests = vec![
            0.000001, // Very close to 0
            0.999999, // Very close to 1
            0.5,      // Exactly at midpoint
        ];

        for prob in extreme_prob_tests {
            let result = lmsr_api::update_market(
                pool,
                &config,
                users[0].id,
                MarketUpdate {
                    event_id,
                    target_prob: prob,
                    stake: 1.0,
                    referral_post_id: None,
                    referral_click_id: None,
                },
            )
            .await;

            match result {
                Ok(_) => println!("✅ Extreme probability {} handled", prob),
                Err(e) => println!("✅ Extreme probability {} rejected: {}", prob, e),
            }
        }

        // Test 3: Rounding consistency in buy/sell cycles
        println!("🔄 Test 3: Rounding consistency test");

        let initial_balance: i64 =
            sqlx::query_scalar("SELECT rp_balance_ledger FROM users WHERE id = $1")
                .bind(users[0].id)
                .fetch_one(pool)
                .await?;

        // Perform multiple small buy/sell cycles
        for cycle in 0..10 {
            let stake = 0.1 + (cycle as f64 * 0.01); // Varying small stakes

            // Buy shares
            let buy_result = lmsr_api::update_market(
                pool,
                &config,
                users[0].id,
                MarketUpdate {
                    event_id,
                    target_prob: 0.6,
                    stake,
                    referral_post_id: None,
                    referral_click_id: None,
                },
            )
            .await?;

            // Sell a portion back
            if buy_result.shares_acquired > 0.01 {
                let sell_amount = buy_result.shares_acquired * 0.5;
                let _sell_result = lmsr_api::sell_shares(
                    pool,
                    &config,
                    users[0].id,
                    event_id,
                    buy_result.share_type.as_str(),
                    sell_amount,
                )
                .await?;
            }
        }

        let final_balance: i64 =
            sqlx::query_scalar("SELECT rp_balance_ledger FROM users WHERE id = $1")
                .bind(users[0].id)
                .fetch_one(pool)
                .await?;

        let balance_change = (initial_balance - final_balance) as f64 / 1_000_000.0;
        println!(
            "✅ Balance change after rounding cycles: {:.6} RP",
            balance_change
        );

        // Balance should have decreased (we paid trading costs) but not by too much
        assert!(
            balance_change >= 0.0,
            "Balance should have decreased due to trading"
        );
        assert!(balance_change < 10.0, "Balance change should be reasonable");

        println!("✅ All numerical precision tests PASSED");
        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

    /// Stress test for numerical stability under sustained randomized trading
    #[tokio::test]
    async fn test_numerical_stability_under_stress() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;

        let user_count = env_usize("STABILITY_STRESS_USERS", 25);
        let event_count = env_usize("STABILITY_STRESS_EVENTS", 25);
        let trades_per_user = env_usize("STABILITY_STRESS_TRADES_PER_USER", 200);
        let min_stake = env_f64("STABILITY_STRESS_MIN_STAKE", 0.0001).max(0.000001);
        let mut max_stake = env_f64("STABILITY_STRESS_MAX_STAKE", 2.0);
        let sell_fraction = env_f64_clamped("STABILITY_STRESS_SELL_FRACTION", 1.0, 0.1, 1.0);
        let min_sell_shares = env_f64("STABILITY_STRESS_MIN_SELL_SHARES", 0.0).max(0.0);
        let holdings_epsilon = env_f64("STABILITY_STRESS_HOLDINGS_EPSILON", 1e-9).max(0.0);
        let seed = env_u64("STABILITY_STRESS_SEED", 1337);
        let ledger_epsilon = env_i64("STABILITY_STRESS_LEDGER_EPSILON", 2);

        if !max_stake.is_finite() || max_stake <= min_stake {
            max_stake = min_stake * 10.0;
        }

        let users = create_test_users(pool, user_count).await?;
        let mut event_ids = Vec::with_capacity(event_count);
        for i in 0..event_count {
            let event_id =
                create_test_event(pool, &format!("Stability Stress Event {}", i)).await?;
            event_ids.push(event_id);
        }
        let config = test_config();

        println!(
            "🔬 Numerical stability stress: users={}, events={}, trades_per_user={}, stake=[{:.6}, {:.6}], sell_fraction={:.2}",
            user_count, event_count, trades_per_user, min_stake, max_stake, sell_fraction
        );

        let total_ops = users.len() * trades_per_user;
        let mut rng = StdRng::seed_from_u64(seed);
        let mut executed_cycles = 0usize;
        let mut skipped_trades = 0usize;
        let mut min_delta_ledger = 0i64;
        let mut max_delta_ledger = 0i64;

        let require_full_round_trip = sell_fraction >= 0.999_999;

        for _ in 0..total_ops {
            let user = &users[rng.gen_range(0..users.len())];
            let event_id = event_ids[rng.gen_range(0..event_ids.len())];

            let existing_shares = sqlx::query(
                "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2"
            )
            .bind(user.id)
            .bind(event_id)
            .fetch_optional(pool)
            .await?;

            if let Some(row) = existing_shares {
                let yes_shares: f64 = row.get("yes_shares");
                let no_shares: f64 = row.get("no_shares");
                if yes_shares > holdings_epsilon || no_shares > holdings_epsilon {
                    skipped_trades += 1;
                    continue;
                }
            }

            let (before_balance, before_staked) = fetch_user_ledger(pool, user.id).await?;
            let before_total = before_balance + before_staked;

            let current_prob: f64 =
                sqlx::query_scalar("SELECT market_prob FROM events WHERE id = $1")
                    .bind(event_id)
                    .fetch_one(pool)
                    .await?;

            let prob_shift = rng.gen_range(0.01..0.2);
            let buy_yes = rng.gen_bool(0.5);
            let target_prob = if buy_yes {
                (current_prob + prob_shift).min(0.999999)
            } else {
                (current_prob - prob_shift).max(0.000001)
            };

            let small_range_max = (min_stake * 10.0).min(max_stake);
            let stake = if rng.gen_bool(0.2) {
                rng.gen_range(min_stake..small_range_max)
            } else {
                rng.gen_range(min_stake..max_stake)
            };

            let update_result = match lmsr_api::update_market(
                pool,
                &config,
                user.id,
                MarketUpdate {
                    event_id,
                    target_prob,
                    stake,
                    referral_post_id: None,
                    referral_click_id: None,
                },
            )
            .await
            {
                Ok(result) => result,
                Err(_) => {
                    skipped_trades += 1;
                    continue;
                }
            };

            if update_result.shares_acquired >= min_sell_shares {
                let sell_amount = update_result.shares_acquired * sell_fraction;
                if sell_amount >= min_sell_shares {
                    lmsr_api::sell_shares(
                        pool,
                        &config,
                        user.id,
                        event_id,
                        update_result.share_type.as_str(),
                        sell_amount,
                    )
                    .await?;
                }
            }

            let (after_balance, after_staked) = fetch_user_ledger(pool, user.id).await?;
            let after_total = after_balance + after_staked;
            let stake_ledger = to_ledger_i64(stake)?;
            let delta_ledger = before_total - after_total;

            if delta_ledger < min_delta_ledger {
                min_delta_ledger = delta_ledger;
            }
            if delta_ledger > max_delta_ledger {
                max_delta_ledger = delta_ledger;
            }

            if require_full_round_trip {
                let remaining_shares = sqlx::query(
                    "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2"
                )
                .bind(user.id)
                .bind(event_id)
                .fetch_optional(pool)
                .await?;

                if let Some(row) = remaining_shares {
                    let yes_shares: f64 = row.get("yes_shares");
                    let no_shares: f64 = row.get("no_shares");
                    assert!(
                        yes_shares <= holdings_epsilon && no_shares <= holdings_epsilon,
                        "Residual shares after round trip: user={} event={} yes={} no={}",
                        user.id,
                        event_id,
                        yes_shares,
                        no_shares
                    );
                }

                let abs_delta = delta_ledger.abs();
                assert!(
                    abs_delta <= ledger_epsilon,
                    "Round-trip drift exceeds epsilon: user={} event={} delta_ledger={} stake_ledger={}",
                    user.id,
                    event_id,
                    delta_ledger,
                    stake_ledger
                );
            }

            executed_cycles += 1;
        }

        assert!(
            executed_cycles > 0,
            "No trades executed during stability test"
        );
        println!(
            "✅ Stability stress completed: executed={}, skipped={}, min_delta_ledger={}, max_delta_ledger={}",
            executed_cycles, skipped_trades, min_delta_ledger, max_delta_ledger
        );

        let event_rows = sqlx::query(
            "SELECT id, market_prob, q_yes, q_no, liquidity_b, cumulative_stake FROM events",
        )
        .fetch_all(pool)
        .await?;

        for row in event_rows {
            let event_id: i32 = row.get("id");
            let market_prob: f64 = row.get("market_prob");
            let q_yes: f64 = row.get("q_yes");
            let q_no: f64 = row.get("q_no");
            let liquidity_b: f64 = row.get("liquidity_b");
            let cumulative_stake: f64 = row.get("cumulative_stake");

            assert!(
                market_prob.is_finite() && market_prob > 0.0 && market_prob < 1.0,
                "Event {} market_prob out of range: {}",
                event_id,
                market_prob
            );
            assert!(
                q_yes.is_finite() && q_yes >= 0.0,
                "Event {} q_yes invalid: {}",
                event_id,
                q_yes
            );
            assert!(
                q_no.is_finite() && q_no >= 0.0,
                "Event {} q_no invalid: {}",
                event_id,
                q_no
            );
            assert!(
                liquidity_b.is_finite() && liquidity_b > 0.0,
                "Event {} liquidity_b invalid: {}",
                event_id,
                liquidity_b
            );
            assert!(
                cumulative_stake.is_finite() && cumulative_stake >= 0.0,
                "Event {} cumulative_stake invalid: {}",
                event_id,
                cumulative_stake
            );
        }

        let share_rows = sqlx::query(
            "SELECT user_id, event_id, yes_shares, no_shares, total_staked_ledger FROM user_shares",
        )
        .fetch_all(pool)
        .await?;

        for row in share_rows {
            let user_id: i32 = row.get("user_id");
            let event_id: i32 = row.get("event_id");
            let yes_shares: f64 = row.get("yes_shares");
            let no_shares: f64 = row.get("no_shares");
            let total_staked_ledger: i64 = row.get("total_staked_ledger");

            assert!(
                yes_shares.is_finite() && yes_shares >= 0.0,
                "User {} event {} yes_shares invalid: {}",
                user_id,
                event_id,
                yes_shares
            );
            assert!(
                no_shares.is_finite() && no_shares >= 0.0,
                "User {} event {} no_shares invalid: {}",
                user_id,
                event_id,
                no_shares
            );
            assert!(
                total_staked_ledger >= 0,
                "User {} event {} total_staked_ledger invalid: {}",
                user_id,
                event_id,
                total_staked_ledger
            );
        }

        let user_rows = sqlx::query("SELECT id, rp_balance_ledger, rp_staked_ledger FROM users")
            .fetch_all(pool)
            .await?;

        for row in user_rows {
            let user_id: i32 = row.get("id");
            let balance_ledger: i64 = row.get("rp_balance_ledger");
            let staked_ledger: i64 = row.get("rp_staked_ledger");

            assert!(
                balance_ledger >= 0,
                "User {} balance_ledger invalid: {}",
                user_id,
                balance_ledger
            );
            assert!(
                staked_ledger >= 0,
                "User {} staked_ledger invalid: {}",
                user_id,
                staked_ledger
            );
        }

        let update_rows = sqlx::query(
            "SELECT id, prev_prob, new_prob, stake_amount, shares_acquired FROM market_updates",
        )
        .fetch_all(pool)
        .await?;

        for row in update_rows {
            let update_id: i32 = row.get("id");
            let prev_prob: f64 = row.get("prev_prob");
            let new_prob: f64 = row.get("new_prob");
            let stake_amount: f64 = row.get("stake_amount");
            let shares_acquired: f64 = row.get("shares_acquired");

            assert!(
                prev_prob.is_finite() && prev_prob > 0.0 && prev_prob < 1.0,
                "Market update {} prev_prob invalid: {}",
                update_id,
                prev_prob
            );
            assert!(
                new_prob.is_finite() && new_prob > 0.0 && new_prob < 1.0,
                "Market update {} new_prob invalid: {}",
                update_id,
                new_prob
            );
            assert!(
                stake_amount.is_finite() && stake_amount > 0.0,
                "Market update {} stake_amount invalid: {}",
                update_id,
                stake_amount
            );
            assert!(
                shares_acquired.is_finite() && shares_acquired >= 0.0,
                "Market update {} shares_acquired invalid: {}",
                update_id,
                shares_acquired
            );
        }

        println!("✅ Numerical stability under stress PASSED");
        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

    #[tokio::test]
    async fn test_numeric_quote_rejects_closed_and_resolved() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;

        let event_id: i32 = sqlx::query_scalar(
            "INSERT INTO events (title, closing_date, event_type)
             VALUES ('closed numeric market', NOW() - INTERVAL '1 hour', 'numeric') RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        sqlx::query(
            "INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric)
             VALUES ($1, 0, 4, 4, 886.0)",
        )
        .bind(event_id)
        .execute(pool)
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
            .fetch_one(pool)
            .await?;
            sqlx::query(
                "INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
                 VALUES ($1, $2, 0, 0.25)",
            )
            .bind(event_id)
            .bind(outcome_id)
            .execute(pool)
            .await?;
        }

        let target = vec![0.25f64; 4];

        // Closed (past closing_date, unresolved) must be rejected.
        let err = crate::lmsr_api::get_numeric_quote(pool, event_id, 1_000_000, target.clone())
            .await
            .expect_err("quote on closed market must fail");
        assert!(err.to_string().contains("Market closed"), "got: {err}");

        // Resolved (outcome set) must be rejected even if closing_date is future.
        sqlx::query(
            "UPDATE events SET outcome = 'resolved_bin_2', closing_date = NOW() + INTERVAL '1 day'
             WHERE id = $1",
        )
        .bind(event_id)
        .execute(pool)
        .await?;
        let err = crate::lmsr_api::get_numeric_quote(pool, event_id, 1_000_000, target.clone())
            .await
            .expect_err("quote on resolved market must fail");
        assert!(err.to_string().contains("Market resolved"), "got: {err}");

        // Control: open + unresolved must still quote successfully.
        sqlx::query("UPDATE events SET outcome = NULL WHERE id = $1")
            .bind(event_id)
            .execute(pool)
            .await?;
        crate::lmsr_api::get_numeric_quote(pool, event_id, 1_000_000, target)
            .await
            .expect("quote on open market must succeed");

        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

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

    #[tokio::test]
    async fn test_market_state_exposes_numeric_market_version() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;

        let event_id: i32 = sqlx::query_scalar(
            "INSERT INTO events (title, closing_date, event_type)
             VALUES ('numeric version probe', NOW() + INTERVAL '7 days', 'numeric') RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        sqlx::query(
            "INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric, numeric_market_version)
             VALUES ($1, 0, 4, 4, 886.0, 7)",
        )
        .bind(event_id)
        .execute(pool)
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
            .execute(pool)
            .await?;
        }

        let state = crate::lmsr_api::get_market_state(pool, event_id).await?;
        assert_eq!(state["numeric_market_version"].as_i64(), Some(7));

        // Binary events report null.
        let binary_id: i32 = sqlx::query_scalar(
            "INSERT INTO events (title, closing_date, event_type)
             VALUES ('binary probe', NOW() + INTERVAL '7 days', 'binary') RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        let state = crate::lmsr_api::get_market_state(pool, binary_id).await?;
        assert!(state["numeric_market_version"].is_null());

        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

    #[tokio::test]
    async fn test_post_resolution_invariant_covers_outcome_tables() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;

        let user_id: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email) VALUES ('inv_user', 'inv@test') RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        let event_id: i32 = sqlx::query_scalar(
            "INSERT INTO events (title, closing_date, event_type, outcome, resolved_at)
             VALUES ('resolved mc', NOW() - INTERVAL '1 day', 'multiple_choice', 'resolved_choice_1', NOW()) RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        let outcome_id: i64 = sqlx::query_scalar(
            "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order) VALUES ($1, 'choice_1', 'Alpha', 0) RETURNING id",
        )
        .bind(event_id)
        .fetch_one(pool)
        .await?;

        // Clean state: invariant holds, and the message names every table checked.
        let result = crate::lmsr_api::verify_post_resolution_invariant(pool, event_id).await?;
        assert_eq!(result["valid"].as_bool(), Some(true), "clean resolved event: {result}");
        let msg = result["message"].as_str().unwrap_or_default();
        assert!(
            msg.contains("user_outcome_shares") && msg.contains("numeric_position_basis"),
            "success message should name all cleared tables: {msg}"
        );

        // Stranded outcome shares: invariant must fail.
        sqlx::query(
            "INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares) VALUES ($1, $2, $3, 4.0)",
        )
        .bind(user_id).bind(event_id).bind(outcome_id)
        .execute(pool)
        .await?;
        let result = crate::lmsr_api::verify_post_resolution_invariant(pool, event_id).await?;
        assert_eq!(result["valid"].as_bool(), Some(false), "stranded outcome shares: {result}");
        sqlx::query("DELETE FROM user_outcome_shares WHERE event_id = $1").bind(event_id).execute(pool).await?;

        // Non-zero numeric basis: invariant must fail.
        sqlx::query(
            "INSERT INTO numeric_position_basis (user_id, event_id, basis_ledger) VALUES ($1, $2, 5000000)",
        )
        .bind(user_id).bind(event_id)
        .execute(pool)
        .await?;
        let result = crate::lmsr_api::verify_post_resolution_invariant(pool, event_id).await?;
        assert_eq!(result["valid"].as_bool(), Some(false), "non-zero basis: {result}");

        // Unresolved event: still valid=true / not-applicable (regression pin).
        let open_id: i32 = sqlx::query_scalar(
            "INSERT INTO events (title, closing_date, event_type) VALUES ('open', NOW() + INTERVAL '1 day', 'binary') RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        let result = crate::lmsr_api::verify_post_resolution_invariant(pool, open_id).await?;
        assert_eq!(result["valid"].as_bool(), Some(true), "unresolved: {result}");

        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

    #[tokio::test]
    async fn test_numeric_settlement_pays_out_and_clears_positions() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;
        // Event with 4 bins [0,1) [1,2) [2,3) [3,4]; resolution value 2.5 -> bin_2 wins.
        let event_id: i32 = sqlx::query_scalar(
            "INSERT INTO events (title, closing_date, event_type)
             VALUES ('settle numeric', NOW() - INTERVAL '1 hour', 'numeric') RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        sqlx::query(
            "INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric)
             VALUES ($1, 0, 4, 4, 886.0)",
        )
        .bind(event_id)
        .execute(pool)
        .await?;
        let mut outcome_ids = Vec::new();
        for i in 0..4i32 {
            let oid: i64 = sqlx::query_scalar(
                "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            )
            .bind(event_id).bind(format!("bin_{i}")).bind(format!("{i}-{}", i + 1))
            .bind(i).bind(i as f64).bind((i + 1) as f64)
            .fetch_one(pool).await?;
            outcome_ids.push(oid);
        }

        // Two users. u1 holds 3.0 shares of the winning bin + 2.0 of a losing bin,
        // basis 4_000_000 (4 RP). u2 holds 1.5 shares of a losing bin, basis 1_000_000.
        // Balances start at 100 RP; staked mirrors basis (numeric staking model:
        // user_outcome_shares.staked_ledger stays 0, stake lives in the basis table).
        let u1: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email, password_hash, rp_balance_ledger, rp_staked_ledger)
             VALUES ('settle_u1', 's1@test', 'x', 100000000, 4000000) RETURNING id",
        ).fetch_one(pool).await?;
        let u2: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email, password_hash, rp_balance_ledger, rp_staked_ledger)
             VALUES ('settle_u2', 's2@test', 'x', 100000000, 1000000) RETURNING id",
        ).fetch_one(pool).await?;
        for (uid, oid, shares) in [(u1, outcome_ids[2], 3.0f64), (u1, outcome_ids[0], 2.0), (u2, outcome_ids[1], 1.5)] {
            sqlx::query(
                "INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
                 VALUES ($1, $2, $3, $4, 0)",
            ).bind(uid).bind(event_id).bind(oid).bind(shares).execute(pool).await?;
        }
        sqlx::query("INSERT INTO numeric_position_basis (user_id, event_id, basis_ledger) VALUES ($1, $2, 4000000), ($3, $2, 1000000)")
            .bind(u1).bind(event_id).bind(u2).execute(pool).await?;

        crate::lmsr_api::resolve_numeric_event(pool, event_id, 2.5).await?;

        // u1: +3.0 shares * 1 RP payout = +3_000_000 balance; staked -4_000_000 -> 0.
        let (b1, s1): (i64, i64) = sqlx::query_as(
            "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1",
        ).bind(u1).fetch_one(pool).await?;
        assert_eq!(b1, 103_000_000);
        assert_eq!(s1, 0);
        // u2: no payout; staked released.
        let (b2, s2): (i64, i64) = sqlx::query_as(
            "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1",
        ).bind(u2).fetch_one(pool).await?;
        assert_eq!(b2, 100_000_000);
        assert_eq!(s2, 0);
        // Positions cleared.
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_outcome_shares WHERE event_id = $1")
            .bind(event_id).fetch_one(pool).await?;
        assert_eq!(remaining, 0);
        let basis: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(basis_ledger), 0)::BIGINT FROM numeric_position_basis WHERE event_id = $1",
        ).bind(event_id).fetch_one(pool).await?;
        assert_eq!(basis, 0);

        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

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

    #[tokio::test]
    async fn test_numeric_settlement_aborts_whole_resolution_on_guard_failure() -> Result<()> {
        let test_db = setup_test_database().await?;
        let pool = &test_db.pool;
        // Same market shape as the payout test: 4 bins [0,1)..[3,4], 2.5 -> bin_2 wins.
        let event_id: i32 = sqlx::query_scalar(
            "INSERT INTO events (title, closing_date, event_type)
             VALUES ('settle abort', NOW() - INTERVAL '1 hour', 'numeric') RETURNING id",
        )
        .fetch_one(pool)
        .await?;
        sqlx::query(
            "INSERT INTO numeric_market_config (event_id, range_min, range_max, bin_count, b_numeric)
             VALUES ($1, 0, 4, 4, 886.0)",
        )
        .bind(event_id)
        .execute(pool)
        .await?;
        let mut outcome_ids = Vec::new();
        for i in 0..4i32 {
            let oid: i64 = sqlx::query_scalar(
                "INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            )
            .bind(event_id).bind(format!("bin_{i}")).bind(format!("{i}-{}", i + 1))
            .bind(i).bind(i as f64).bind((i + 1) as f64)
            .fetch_one(pool).await?;
            outcome_ids.push(oid);
        }

        // u1 is a healthy winner. u2's ledger is corrupt: basis says 1 RP staked
        // on this event but rp_staked_ledger is 0, so releasing the stake would
        // drive it negative — the batch UPDATE's guard must reject that row and
        // the whole resolution must abort with no partial payout.
        let u1: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email, password_hash, rp_balance_ledger, rp_staked_ledger)
             VALUES ('abort_u1', 'a1@test', 'x', 100000000, 4000000) RETURNING id",
        ).fetch_one(pool).await?;
        let u2: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email, password_hash, rp_balance_ledger, rp_staked_ledger)
             VALUES ('abort_u2', 'a2@test', 'x', 100000000, 0) RETURNING id",
        ).fetch_one(pool).await?;
        for (uid, oid, shares) in [(u1, outcome_ids[2], 3.0f64), (u2, outcome_ids[1], 1.5)] {
            sqlx::query(
                "INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
                 VALUES ($1, $2, $3, $4, 0)",
            ).bind(uid).bind(event_id).bind(oid).bind(shares).execute(pool).await?;
        }
        sqlx::query("INSERT INTO numeric_position_basis (user_id, event_id, basis_ledger) VALUES ($1, $2, 4000000), ($3, $2, 1000000)")
            .bind(u1).bind(event_id).bind(u2).execute(pool).await?;

        let err = crate::lmsr_api::resolve_numeric_event(pool, event_id, 2.5)
            .await
            .expect_err("guard-rejected settlement row must fail the resolution");
        assert!(
            err.to_string().contains("aborting resolution"),
            "expected the settlement abort branch, got: {err}"
        );

        // Nothing may persist from the rolled-back transaction: balances,
        // positions, basis, and the event's resolution state are untouched.
        let (b1, s1): (i64, i64) = sqlx::query_as(
            "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1",
        ).bind(u1).fetch_one(pool).await?;
        assert_eq!((b1, s1), (100_000_000, 4_000_000), "winner must not be paid on abort");
        let (b2, s2): (i64, i64) = sqlx::query_as(
            "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1",
        ).bind(u2).fetch_one(pool).await?;
        assert_eq!((b2, s2), (100_000_000, 0), "corrupt row must be untouched");
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_outcome_shares WHERE event_id = $1")
            .bind(event_id).fetch_one(pool).await?;
        assert_eq!(remaining, 2, "positions must survive the rollback");
        let basis: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(basis_ledger), 0)::BIGINT FROM numeric_position_basis WHERE event_id = $1",
        ).bind(event_id).fetch_one(pool).await?;
        assert_eq!(basis, 5_000_000, "basis must survive the rollback");
        let resolved_at: Option<Option<String>> = sqlx::query_scalar(
            "SELECT resolved_at::TEXT FROM events WHERE id = $1",
        ).bind(event_id).fetch_optional(pool).await?;
        assert_eq!(resolved_at, Some(None), "event must remain unresolved");

        cleanup_test_database(test_db.pool, &test_db.db_name).await?;
        Ok(())
    }

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
}
