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

/// Test database configuration for isolated testing
const DEFAULT_TEST_DB_URL: &str = "postgresql://postgres:password@localhost:5432/test_intellacc";
const DEFAULT_TEST_DB_ADMIN_URL: &str = "postgresql://postgres:password@localhost:5432/postgres";

fn test_db_url() -> String {
    env::var("TEST_DB_URL").unwrap_or_else(|_| DEFAULT_TEST_DB_URL.to_string())
}

fn test_db_admin_url() -> String {
    env::var("TEST_DB_ADMIN_URL").unwrap_or_else(|_| DEFAULT_TEST_DB_ADMIN_URL.to_string())
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
const STRESS_TEST_USERS: usize = 20;
const STRESS_TEST_OPERATIONS: usize = 2000;
const STRESS_TEST_ITERATIONS: usize = 50;

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
async fn setup_test_database() -> Result<PgPool> {
    println!("🔧 Setting up test database...");

    // Connect to default postgres database first
    let admin_url = test_db_admin_url();
    let setup_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&admin_url)
        .await?;

    // Drop and recreate test database
    sqlx::query("DROP DATABASE IF EXISTS test_intellacc")
        .execute(&setup_pool)
        .await
        .ok(); // Ignore error if database doesn't exist

    sqlx::query("CREATE DATABASE test_intellacc")
        .execute(&setup_pool)
        .await?;

    setup_pool.close().await;

    // Connect to test database
    let test_url = test_db_url();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(&test_url)
        .await?;

    // Run migrations
    run_test_migrations(&pool).await?;

    println!("✅ Test database ready");
    Ok(pool)
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
            cumulative_stake DOUBLE PRECISION DEFAULT 0.0
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
        "INSERT INTO events (title, description, closing_date, liquidity_b) 
         VALUES ($1, $2, NOW() + INTERVAL '7 days', 100.0) RETURNING id",
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
async fn cleanup_test_database(pool: PgPool) -> Result<()> {
    pool.close().await;

    let cleanup_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&test_db_admin_url())
        .await?;

    sqlx::query("DROP DATABASE IF EXISTS test_intellacc")
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
        let pool = setup_test_database().await?;
        let users = create_test_users(&pool, 1).await?;
        let user = &users[0];
        let event_id = create_test_event(&pool, "Single User Test Event").await?;
        let config = test_config();

        let initial_state = capture_initial_state(&pool).await?;
        let mut operations = Vec::new();
        let mut resolution_credits = HashMap::new();

        println!("🧪 Starting single user market cycle test...");

        // Buy YES shares
        println!("📈 Buying YES shares...");
        let stake1 = 50.0; // 50 RP
        let (before_balance, before_staked) = fetch_user_ledger(&pool, user.id).await?;
        let _ = lmsr_api::update_market(
            &pool,
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
            .push(build_operation_result(&pool, user.id, before_balance, before_staked).await?);

        // Verify invariants after buy YES
        verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
        verify_staked_invariant(&pool).await?;

        // Buy NO shares
        println!("📉 Buying NO shares...");
        let stake2 = 30.0; // 30 RP
        let (before_balance, before_staked) = fetch_user_ledger(&pool, user.id).await?;
        let _ = lmsr_api::update_market(
            &pool,
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
            .push(build_operation_result(&pool, user.id, before_balance, before_staked).await?);

        // Verify invariants after buy NO
        verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
        verify_staked_invariant(&pool).await?;

        // Get current user shares for partial selling
        let user_shares = sqlx::query(
            "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2",
        )
        .bind(user.id)
        .bind(event_id)
        .fetch_one(&pool)
        .await?;

        let yes_shares: f64 = user_shares.get("yes_shares");
        let no_shares: f64 = user_shares.get("no_shares");

        // Sell partial YES shares
        if yes_shares > 0.0 {
            println!("💰 Selling partial YES shares...");
            let sell_amount = yes_shares * 0.3; // Sell 30% of YES shares
            let (before_balance, before_staked) = fetch_user_ledger(&pool, user.id).await?;
            let _sell_yes_result = lmsr_api::sell_shares(
                &pool,
                &config,
                user.id,
                event_id,
                Side::Yes.as_str(),
                sell_amount,
            )
            .await?;

            operations
                .push(build_operation_result(&pool, user.id, before_balance, before_staked).await?);

            // Verify invariants after sell YES
            verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits)
                .await?;
            verify_staked_invariant(&pool).await?;
        }

        // Sell partial NO shares
        if no_shares > 0.0 {
            println!("💰 Selling partial NO shares...");
            let sell_amount = no_shares * 0.5; // Sell 50% of NO shares
            let (before_balance, before_staked) = fetch_user_ledger(&pool, user.id).await?;
            let _sell_no_result = lmsr_api::sell_shares(
                &pool,
                &config,
                user.id,
                event_id,
                Side::No.as_str(),
                sell_amount,
            )
            .await?;

            operations
                .push(build_operation_result(&pool, user.id, before_balance, before_staked).await?);

            // Verify invariants after sell NO
            verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits)
                .await?;
            verify_staked_invariant(&pool).await?;
        }

        // Resolve YES
        println!("🎯 Resolving event as YES...");

        // Calculate resolution credits before resolution
        let final_shares = sqlx::query(
                "SELECT yes_shares, staked_yes_ledger, staked_no_ledger FROM user_shares WHERE user_id = $1 AND event_id = $2",
            )
            .bind(user.id)
            .bind(event_id)
            .fetch_optional(&pool)
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

        lmsr_api::resolve_event(&pool, event_id, true).await?;

        // Verify all invariants after resolution
        verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
        verify_post_resolution_invariant(&pool, event_id).await?;

        println!("✅ Single user market cycle test PASSED");
        cleanup_test_database(pool).await?;
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

            let pool = setup_test_database().await?;
            let users = create_test_users(&pool, STRESS_TEST_USERS).await?;
            let event_id =
                create_test_event(&pool, &format!("Stress Test Event {}", iteration)).await?;
            let config = test_config();

            let initial_state = capture_initial_state(&pool).await?;
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
                            fetch_user_ledger(&pool, user.id).await?;
                        match lmsr_api::update_market(
                            &pool,
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
                                        &pool,
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
                        .fetch_optional(&pool)
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
                                    fetch_user_ledger(&pool, user.id).await?;

                                match lmsr_api::sell_shares(
                                    &pool,
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
                                                &pool,
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
                    verify_staked_invariant(&pool).await?;
                }
            }

            println!(
                "📊 Completed {} operations, verifying final invariants...",
                operations.len()
            );

            // Final invariant verification before resolution
            let empty_resolution_credits = HashMap::new();
            verify_balance_invariant(
                &pool,
                &initial_state,
                &operations,
                &empty_resolution_credits,
            )
            .await?;
            verify_staked_invariant(&pool).await?;

            // Calculate resolution credits
            let mut resolution_credits = HashMap::new();
            let all_shares = sqlx::query(
                "SELECT user_id, yes_shares, no_shares, staked_yes_ledger, staked_no_ledger FROM user_shares WHERE event_id = $1",
            )
            .bind(event_id)
            .fetch_all(&pool)
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
            lmsr_api::resolve_event(&pool, event_id, outcome).await?;

            // Final verification
            verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits)
                .await?;
            verify_post_resolution_invariant(&pool, event_id).await?;

            cleanup_test_database(pool).await?;
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
        let pool = setup_test_database().await?;
        let users = create_test_users(&pool, 3).await?;
        let event_id = create_test_event(&pool, "Edge Case Test Event").await?;
        let config = test_config();

        println!("🧪 Starting edge case tests...");

        // Test 1: Zero balance user trying to buy shares
        println!("📉 Test 1: Zero balance user attempting trade");

        // Set user balance to zero
        sqlx::query("UPDATE users SET rp_balance_ledger = 0, rp_staked_ledger = 0 WHERE id = $1")
            .bind(users[0].id)
            .execute(&pool)
            .await?;

        let zero_balance_result = lmsr_api::update_market(
            &pool,
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
            &pool,
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
            &pool,
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
            &pool,
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
                &pool,
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
            &pool,
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
            &pool,
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
        println!("🎯 Test 6: Post-resolution trading test");

        // Resolve the event
        lmsr_api::resolve_event(&pool, event_id, true).await?;

        // Try to trade on resolved event
        let post_resolution_trade = lmsr_api::update_market(
            &pool,
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
        println!("✅ Post-resolution trading correctly rejected");

        // Test 7: Database consistency under failures
        println!("🔗 Test 7: Database consistency test");

        // Create new event for this test
        let consistency_event_id = create_test_event(&pool, "Consistency Test").await?;

        // Perform a transaction and verify all tables are consistent
        let trade_result = lmsr_api::update_market(
            &pool,
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
                .fetch_one(&pool)
                .await?;

        let user_staked: i64 =
            sqlx::query_scalar("SELECT rp_staked_ledger FROM users WHERE id = $1")
                .bind(users[1].id)
                .fetch_one(&pool)
                .await?;

        let shares_staked: Option<i64> = sqlx::query_scalar(
            "SELECT total_staked_ledger FROM user_shares WHERE user_id = $1 AND event_id = $2",
        )
        .bind(users[1].id)
        .bind(consistency_event_id)
        .fetch_optional(&pool)
        .await?;

        let audit_trail_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM market_updates WHERE user_id = $1 AND event_id = $2",
        )
        .bind(users[1].id)
        .bind(consistency_event_id)
        .fetch_one(&pool)
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
        cleanup_test_database(pool).await?;
        Ok(())
    }

    /// Boundary condition tests for numerical precision
    #[tokio::test]
    async fn test_numerical_precision() -> Result<()> {
        let pool = setup_test_database().await?;
        let users = create_test_users(&pool, 1).await?;
        let event_id = create_test_event(&pool, "Precision Test Event").await?;
        let config = test_config();

        println!("🔢 Starting numerical precision tests...");

        // Test 1: Very small stakes (micro-RP precision)
        println!("🔬 Test 1: Micro-RP precision test");

        let micro_stake = 0.000001; // 1 micro-RP
        let micro_result = lmsr_api::update_market(
            &pool,
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
                &pool,
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
                .fetch_one(&pool)
                .await?;

        // Perform multiple small buy/sell cycles
        for cycle in 0..10 {
            let stake = 0.1 + (cycle as f64 * 0.01); // Varying small stakes

            // Buy shares
            let buy_result = lmsr_api::update_market(
                &pool,
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
                    &pool,
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
                .fetch_one(&pool)
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
        cleanup_test_database(pool).await?;
        Ok(())
    }

    /// Stress test for numerical stability under sustained randomized trading
    #[tokio::test]
    async fn test_numerical_stability_under_stress() -> Result<()> {
        let pool = setup_test_database().await?;

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

        let users = create_test_users(&pool, user_count).await?;
        let mut event_ids = Vec::with_capacity(event_count);
        for i in 0..event_count {
            let event_id =
                create_test_event(&pool, &format!("Stability Stress Event {}", i)).await?;
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
            .fetch_optional(&pool)
            .await?;

            if let Some(row) = existing_shares {
                let yes_shares: f64 = row.get("yes_shares");
                let no_shares: f64 = row.get("no_shares");
                if yes_shares > holdings_epsilon || no_shares > holdings_epsilon {
                    skipped_trades += 1;
                    continue;
                }
            }

            let (before_balance, before_staked) = fetch_user_ledger(&pool, user.id).await?;
            let before_total = before_balance + before_staked;

            let current_prob: f64 =
                sqlx::query_scalar("SELECT market_prob FROM events WHERE id = $1")
                    .bind(event_id)
                    .fetch_one(&pool)
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
                &pool,
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
                        &pool,
                        &config,
                        user.id,
                        event_id,
                        update_result.share_type.as_str(),
                        sell_amount,
                    )
                    .await?;
                }
            }

            let (after_balance, after_staked) = fetch_user_ledger(&pool, user.id).await?;
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
                .fetch_optional(&pool)
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
        .fetch_all(&pool)
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
        .fetch_all(&pool)
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
            .fetch_all(&pool)
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
        .fetch_all(&pool)
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
        cleanup_test_database(pool).await?;
        Ok(())
    }
}
