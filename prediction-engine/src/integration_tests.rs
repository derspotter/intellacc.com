//! Integration tests for LMSR API/DB layer
//! 
//! These tests verify the complete API/database flow including:
//! - buy YES, buy NO, sell partial YES, sell partial NO, resolve YES 
//! - All financial invariants are maintained
//! - High load and repeated scenarios
//! - Concurrency safety

use crate::lmsr_api;
use crate::lmsr_core::{to_ledger_units, from_ledger_units, Side};
use crate::db_adapter::DbAdapter;
use crate::config::Config;
use sqlx::{PgPool, Row, Executor};
use anyhow::{Result, anyhow};
use std::collections::HashMap;
use rand::Rng;
use tokio_test;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;

/// Test database configuration for isolated testing
const TEST_DB_URL: &str = "postgresql://postgres:password@localhost:5432/test_intellacc";

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
    username: String,
    initial_balance_ledger: i64,
    initial_staked_ledger: i64,
}

/// Market operation result for tracking
#[derive(Debug)]
struct OperationResult {
    user_id: i32,
    operation: String,
    balance_change: i64,
    staked_change: i64,
    cost_ledger: i64,
    shares_acquired: f64,
}

/// Setup test database with clean state
async fn setup_test_database() -> Result<PgPool> {
    println!("🔧 Setting up test database...");
    
    // Connect to default postgres database first
    let setup_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect("postgresql://postgres:password@localhost:5432/postgres")
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
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(TEST_DB_URL)
        .await?;
    
    // Run migrations
    run_test_migrations(&pool).await?;
    
    println!("✅ Test database ready");
    Ok(pool)
}

/// Run essential migrations for testing
async fn run_test_migrations(pool: &PgPool) -> Result<()> {
    // Create users table
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            rp_balance DECIMAL(15,6) DEFAULT 1000.0,
            rp_staked DECIMAL(15,6) DEFAULT 0.0,
            rp_balance_ledger BIGINT DEFAULT 1000000000,
            rp_staked_ledger BIGINT DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            CONSTRAINT users_rp_balance_non_negative CHECK (rp_balance >= 0),
            CONSTRAINT users_rp_staked_non_negative CHECK (rp_staked >= 0),
            CONSTRAINT rp_balance_ledger_non_negative CHECK (rp_balance_ledger >= 0),
            CONSTRAINT rp_staked_ledger_non_negative CHECK (rp_staked_ledger >= 0)
        )
    "#).execute(pool).await?;
    
    // Create events table
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS events (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            outcome VARCHAR(50),
            closing_date TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            market_prob DECIMAL(15,10) DEFAULT 0.5,
            liquidity_b DECIMAL(15,6) DEFAULT 100.0,
            q_yes DECIMAL(15,6) DEFAULT 0.0,
            q_no DECIMAL(15,6) DEFAULT 0.0,
            cumulative_stake DECIMAL(15,6) DEFAULT 0.0
        )
    "#).execute(pool).await?;
    
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
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS market_updates (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            event_id INTEGER NOT NULL REFERENCES events(id),
            update_type VARCHAR(20) NOT NULL,  -- 'buy_yes', 'buy_no', 'sell_yes', 'sell_no'
            prev_prob DECIMAL(15,10) NOT NULL,
            new_prob DECIMAL(15,10) NOT NULL,
            stake_amount DECIMAL(15,6) NOT NULL,
            shares_acquired DECIMAL(15,6) NOT NULL,
            share_type VARCHAR(10) NOT NULL,   -- 'yes' or 'no'
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
    "#).execute(pool).await?;
    
    // Create helper functions
    sqlx::query(r#"
        CREATE OR REPLACE FUNCTION decimal_to_ledger(decimal_val NUMERIC) RETURNS BIGINT AS $$
        BEGIN
            RETURN ROUND(decimal_val * 1000000)::BIGINT;
        END;
        $$ LANGUAGE plpgsql IMMUTABLE;
    "#).execute(pool).await?;
    
    sqlx::query(r#"
        CREATE OR REPLACE FUNCTION ledger_to_decimal(ledger_val BIGINT) RETURNS NUMERIC AS $$
        BEGIN
            RETURN (ledger_val::NUMERIC / 1000000);
        END;
        $$ LANGUAGE plpgsql IMMUTABLE;
    "#).execute(pool).await?;
    
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
             VALUES ($1, $2, $3, 0) RETURNING id"
        )
        .bind(&username)
        .bind(&email)
        .bind(INITIAL_BALANCE_LEDGER)
        .fetch_one(pool)
        .await?;
        
        users.push(TestUser {
            id: user_id,
            username,
            initial_balance_ledger: INITIAL_BALANCE_LEDGER,
            initial_staked_ledger: 0,
        });
    }
    
    println!("✅ Created {} test users", count);
    Ok(users)
}

/// Create test event
async fn create_test_event(pool: &PgPool, title: &str) -> Result<i32> {
    let event_id: i32 = sqlx::query_scalar(
        "INSERT INTO events (title, description, closing_date, liquidity_b) 
         VALUES ($1, $2, NOW() + INTERVAL '7 days', 100.0) RETURNING id"
    )
    .bind(title)
    .bind("Integration test event")
    .fetch_one(pool)
    .await?;
    
    Ok(event_id)
}

/// Capture initial system state for invariant checking
async fn capture_initial_state(pool: &PgPool) -> Result<HashMap<i32, (i64, i64)>> {
    let rows = sqlx::query(
        "SELECT id, rp_balance_ledger, rp_staked_ledger FROM users"
    )
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

/// Verify primary financial invariant: users.rp_balance + users.rp_staked == initial + Σ(ledger ΔC) + Σ(resolution credits)
async fn verify_balance_invariant(
    pool: &PgPool, 
    initial_state: &HashMap<i32, (i64, i64)>,
    operations: &[OperationResult],
    resolution_credits: &HashMap<i32, i64>
) -> Result<()> {
    let current_state = sqlx::query(
        "SELECT id, rp_balance_ledger, rp_staked_ledger FROM users"
    )
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
        let operation_changes: i64 = operations.iter()
            .filter(|op| op.user_id == user_id)
            .map(|op| op.balance_change + op.staked_change)
            .sum();
        
        let resolution_credit = resolution_credits.get(&user_id).unwrap_or(&0);
        let expected_total = initial_total + operation_changes + resolution_credit;
        
        if current_total != expected_total {
            return Err(anyhow!(
                "Balance invariant violation for user {}: expected {}, got {} (diff: {})",
                user_id, expected_total, current_total, current_total - expected_total
            ));
        }
    }
    
    println!("✅ Balance invariant verified for all users");
    Ok(())
}

/// Verify staked consistency: users.rp_staked == Σ user_shares.total_staked_ledger (before resolution)
async fn verify_staked_invariant(pool: &PgPool) -> Result<()> {
    let user_staked = sqlx::query(
        "SELECT id, rp_staked_ledger FROM users ORDER BY id"
    )
    .fetch_all(pool)
    .await?;
    
    for row in user_staked {
        let user_id: i32 = row.get("id");
        let user_staked_ledger: i64 = row.get("rp_staked_ledger");
        
        // Convert to regular RP for comparison
        let user_staked_rp = (user_staked_ledger as f64) / 1_000_000.0;
        
        let total_shares_staked: Option<Decimal> = sqlx::query_scalar(
            "SELECT COALESCE(SUM(ledger_to_decimal(total_staked_ledger)), 0) 
             FROM user_shares WHERE user_id = $1"
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        
        let shares_staked_rp = total_shares_staked.unwrap_or(Decimal::from(0)).to_f64().unwrap_or(0.0);
        
        let diff = (user_staked_rp - shares_staked_rp).abs();
        if diff > 0.000001 { // Allow for small floating point differences
            return Err(anyhow!(
                "Staked invariant violation for user {}: user.rp_staked={}, Σ(user_shares.total_staked_ledger)={} (diff: {})",
                user_id, user_staked_rp, shares_staked_rp, diff
            ));
        }
    }
    
    println!("✅ Staked invariant verified for all users");
    Ok(())
}

/// Verify post-resolution invariant: user_shares rows cleared; rp_staked unchanged by further reads
async fn verify_post_resolution_invariant(pool: &PgPool, event_id: i32) -> Result<()> {
    // Check that user_shares rows are cleared for the resolved event
    let remaining_shares: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_shares WHERE event_id = $1"
    )
    .bind(event_id)
    .fetch_one(pool)
    .await?;
    
    if remaining_shares != 0 {
        return Err(anyhow!(
            "Post-resolution invariant violation: {} user_shares rows remain for event {}",
            remaining_shares, event_id
        ));
    }
    
    // Verify that subsequent reads don't modify rp_staked
    let staked_before = sqlx::query(
        "SELECT id, rp_staked_ledger FROM users ORDER BY id"
    )
    .fetch_all(pool)
    .await?;
    
    // Perform some read operations
    let _market_state = sqlx::query(
        "SELECT market_prob, liquidity_b FROM events WHERE id = $1"
    )
    .bind(event_id)
    .fetch_optional(pool)
    .await?;
    
    let _user_balances = sqlx::query(
        "SELECT rp_balance_ledger, rp_staked_ledger FROM users"
    )
    .fetch_all(pool)
    .await?;
    
    let staked_after = sqlx::query(
        "SELECT id, rp_staked_ledger FROM users ORDER BY id"
    )
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
        .connect("postgresql://postgres:password@localhost:5432/postgres")
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
    use tokio_test;
    
    /// Single user market cycle test
    #[tokio::test]
    async fn test_single_user_market_cycle() -> Result<()> {
        let pool = setup_test_database().await?;
        let users = create_test_users(&pool, 1).await?;
        let user = &users[0];
        let event_id = create_test_event(&pool, "Single User Test Event").await?;
        
        let initial_state = capture_initial_state(&pool).await?;
        let mut operations = Vec::new();
        let mut resolution_credits = HashMap::new();
        
        println!("🧪 Starting single user market cycle test...");
        
        // Buy YES shares
        println("📈 Buying YES shares...");
        let stake1 = 50.0; // 50 RP
        let buy_yes_result = lmsr_api::update_market_probability(
            &pool, 
            event_id, 
            user.id, 
            0.7, 
            to_ledger_units(stake1)?
        ).await?;
        
        operations.push(OperationResult {
            user_id: user.id,
            operation: "buy_yes".to_string(),
            balance_change: -(buy_yes_result.cost_ledger as i64),
            staked_change: buy_yes_result.cost_ledger as i64,
            cost_ledger: buy_yes_result.cost_ledger as i64,
            shares_acquired: buy_yes_result.shares_acquired,
        });
        
        // Verify invariants after buy YES
        verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
        verify_staked_invariant(&pool).await?;
        
        // Buy NO shares
        println!("📉 Buying NO shares...");
        let stake2 = 30.0; // 30 RP
        let buy_no_result = lmsr_api::update_market_probability(
            &pool,
            event_id,
            user.id,
            0.4,
            to_ledger_units(stake2)?
        ).await?;
        
        operations.push(OperationResult {
            user_id: user.id,
            operation: "buy_no".to_string(),
            balance_change: -(buy_no_result.cost_ledger as i64),
            staked_change: buy_no_result.cost_ledger as i64,
            cost_ledger: buy_no_result.cost_ledger as i64,
            shares_acquired: buy_no_result.shares_acquired,
        });
        
        // Verify invariants after buy NO
        verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
        verify_staked_invariant(&pool).await?;
        
        // Get current user shares for partial selling
        let user_shares = sqlx::query(
            "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2"
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
            let sell_yes_result = lmsr_api::sell_shares(
                &pool,
                user.id,
                event_id,
                Side::Yes,
                sell_amount
            ).await?;
            
            operations.push(OperationResult {
                user_id: user.id,
                operation: "sell_yes".to_string(),
                balance_change: sell_yes_result.payout_ledger as i64,
                staked_change: -(sell_yes_result.stake_unwound_ledger as i64),
                cost_ledger: -(sell_yes_result.payout_ledger as i64),
                shares_acquired: -sell_amount,
            });
            
            // Verify invariants after sell YES
            verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
            verify_staked_invariant(&pool).await?;
        }
        
        // Sell partial NO shares
        if no_shares > 0.0 {
            println!("💰 Selling partial NO shares...");
            let sell_amount = no_shares * 0.5; // Sell 50% of NO shares
            let sell_no_result = lmsr_api::sell_shares(
                &pool,
                user.id,
                event_id,
                Side::No,
                sell_amount
            ).await?;
            
            operations.push(OperationResult {
                user_id: user.id,
                operation: "sell_no".to_string(),
                balance_change: sell_no_result.payout_ledger as i64,
                staked_change: -(sell_no_result.stake_unwound_ledger as i64),
                cost_ledger: -(sell_no_result.payout_ledger as i64),
                shares_acquired: -sell_amount,
            });
            
            // Verify invariants after sell NO
            verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
            verify_staked_invariant(&pool).await?;
        }
        
        // Resolve YES
        println!("🎯 Resolving event as YES...");
        
        // Calculate resolution credits before resolution
        let final_shares = sqlx::query(
            "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2"
        )
        .bind(user.id)
        .bind(event_id)
        .fetch_optional(&pool)
        .await?;
        
        if let Some(shares_row) = final_shares {
            let final_yes_shares: f64 = shares_row.get("yes_shares");
            let final_no_shares: f64 = shares_row.get("no_shares");
            
            // YES outcome: YES shares worth 1 RP each, NO shares worth 0
            let resolution_value = final_yes_shares; // + final_no_shares * 0.0
            resolution_credits.insert(user.id, to_ledger_units(resolution_value)?);
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
            println!("🔥 Stress test iteration {}/{}", iteration + 1, STRESS_TEST_ITERATIONS);
            
            let pool = setup_test_database().await?;
            let users = create_test_users(&pool, STRESS_TEST_USERS).await?;
            let event_id = create_test_event(&pool, &format!("Stress Test Event {}", iteration)).await?;
            
            let initial_state = capture_initial_state(&pool).await?;
            let mut operations = Vec::new();
            let mut rng = rand::thread_rng();
            
            println!("⚡ Executing {} random operations...", STRESS_TEST_OPERATIONS);
            
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
                        
                        match lmsr_api::update_market_probability(
                            &pool,
                            event_id,
                            user.id,
                            target_prob,
                            to_ledger_units(stake)?
                        ).await {
                            Ok(result) => {
                                operations.push(OperationResult {
                                    user_id: user.id,
                                    operation: if operation_type == 0 { "buy_yes".to_string() } else { "buy_no".to_string() },
                                    balance_change: -(result.cost_ledger as i64),
                                    staked_change: result.cost_ledger as i64,
                                    cost_ledger: result.cost_ledger as i64,
                                    shares_acquired: result.shares_acquired,
                                });
                            },
                            Err(_) => {
                                // Expected for some operations (insufficient balance, etc.)
                                continue;
                            }
                        }
                    },
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
                                
                                match lmsr_api::sell_shares(&pool, user.id, event_id, side, sell_amount).await {
                                    Ok(result) => {
                                        operations.push(OperationResult {
                                            user_id: user.id,
                                            operation: if operation_type == 2 { "sell_yes".to_string() } else { "sell_no".to_string() },
                                            balance_change: result.payout_ledger as i64,
                                            staked_change: -(result.stake_unwound_ledger as i64),
                                            cost_ledger: -(result.payout_ledger as i64),
                                            shares_acquired: -sell_amount,
                                        });
                                    },
                                    Err(_) => {
                                        // Expected for some operations
                                        continue;
                                    }
                                }
                            }
                        }
                    },
                    _ => unreachable!()
                }
                
                // Verify invariants periodically
                if op_idx % 100 == 0 {
                    verify_staked_invariant(&pool).await?;
                }
            }
            
            println!("📊 Completed {} operations, verifying final invariants...", operations.len());
            
            // Final invariant verification before resolution
            let empty_resolution_credits = HashMap::new();
            verify_balance_invariant(&pool, &initial_state, &operations, &empty_resolution_credits).await?;
            verify_staked_invariant(&pool).await?;
            
            // Calculate resolution credits
            let mut resolution_credits = HashMap::new();
            let all_shares = sqlx::query(
                "SELECT user_id, yes_shares, no_shares FROM user_shares WHERE event_id = $1"
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
                
                resolution_credits.insert(user_id, to_ledger_units(resolution_value)?);
            }
            
            // Resolve event
            lmsr_api::resolve_event(&pool, event_id, outcome).await?;
            
            // Final verification
            verify_balance_invariant(&pool, &initial_state, &operations, &resolution_credits).await?;
            verify_post_resolution_invariant(&pool, event_id).await?;
            
            cleanup_test_database(pool).await?;
        }
        
        println!("✅ Multi-user stress test PASSED ({} iterations)", STRESS_TEST_ITERATIONS);
        Ok(())
    }
    
    /// Edge case tests: zero balance, max stake, insufficient funds, etc.
    #[tokio::test]
    async fn test_edge_cases() -> Result<()> {
        let pool = setup_test_database().await?;
        let users = create_test_users(&pool, 3).await?;
        let event_id = create_test_event(&pool, "Edge Case Test Event").await?;
        
        println!("🧪 Starting edge case tests...");
        
        // Test 1: Zero balance user trying to buy shares
        println!("📉 Test 1: Zero balance user attempting trade");
        
        // Set user balance to zero
        sqlx::query("UPDATE users SET rp_balance_ledger = 0, rp_staked_ledger = 0 WHERE id = $1")
            .bind(users[0].id)
            .execute(&pool)
            .await?;
        
        let zero_balance_result = lmsr_api::update_market_probability(
            &pool,
            event_id,
            users[0].id,
            0.7,
            to_ledger_units(100.0)?
        ).await;
        
        assert!(zero_balance_result.is_err(), "Zero balance user should not be able to trade");
        println!("✅ Zero balance user correctly rejected");
        
        // Test 2: Maximum stake amount (should hit overflow protection)
        println!("💥 Test 2: Maximum stake amount test");
        let max_stake_result = lmsr_api::update_market_probability(
            &pool,
            event_id,
            users[1].id,
            0.9,
            to_ledger_units(1_000_000.0)? // Very large stake
        ).await;
        
        // This should either succeed with limited impact or fail gracefully
        match max_stake_result {
            Ok(_) => println!("✅ Large stake handled gracefully"),
            Err(e) => println!("✅ Large stake rejected: {}", e),
        }
        
        // Test 3: Selling more shares than owned
        println!("🚫 Test 3: Overselling shares test");
        
        // First, give user some shares
        let buy_result = lmsr_api::update_market_probability(
            &pool,
            event_id,
            users[2].id,
            0.6,
            to_ledger_units(50.0)?
        ).await?;
        
        // Try to sell more than owned
        let oversell_result = lmsr_api::sell_shares(
            &pool,
            users[2].id,
            event_id,
            Side::Yes,
            buy_result.shares_acquired * 2.0 // Try to sell double what we own
        ).await;
        
        assert!(oversell_result.is_err(), "Should not be able to oversell shares");
        println!("✅ Overselling correctly rejected");
        
        // Test 4: Concurrent transactions (race condition test)
        println!("🏃 Test 4: Concurrent transaction test");
        
        let futures = (0..10).map(|_| {
            lmsr_api::update_market_probability(
                &pool,
                event_id,
                users[1].id,
                0.55,
                to_ledger_units(10.0).unwrap()
            )
        });
        
        let results = futures_util::future::join_all(futures).await;
        let successful_trades = results.iter().filter(|r| r.is_ok()).count();
        
        println!("✅ Concurrent transactions: {}/10 succeeded", successful_trades);
        
        // Test 5: Invalid probability bounds
        println!("📊 Test 5: Invalid probability bounds test");
        
        let invalid_prob_high = lmsr_api::update_market_probability(
            &pool,
            event_id,
            users[1].id,
            1.5, // Invalid: > 1.0
            to_ledger_units(10.0)?
        ).await;
        
        let invalid_prob_low = lmsr_api::update_market_probability(
            &pool,
            event_id,
            users[1].id,
            -0.1, // Invalid: < 0.0
            to_ledger_units(10.0)?
        ).await;
        
        assert!(invalid_prob_high.is_err(), "Probability > 1.0 should be rejected");
        assert!(invalid_prob_low.is_err(), "Probability < 0.0 should be rejected");
        println!("✅ Invalid probabilities correctly rejected");
        
        // Test 6: Post-resolution trading attempts
        println!("🎯 Test 6: Post-resolution trading test");
        
        // Resolve the event
        lmsr_api::resolve_event(&pool, event_id, true).await?;
        
        // Try to trade on resolved event
        let post_resolution_trade = lmsr_api::update_market_probability(
            &pool,
            event_id,
            users[1].id,
            0.7,
            to_ledger_units(20.0)?
        ).await;
        
        assert!(post_resolution_trade.is_err(), "Trading on resolved event should be rejected");
        println!("✅ Post-resolution trading correctly rejected");
        
        // Test 7: Database consistency under failures
        println!("🔗 Test 7: Database consistency test");
        
        // Create new event for this test
        let consistency_event_id = create_test_event(&pool, "Consistency Test").await?;
        
        // Perform a transaction and verify all tables are consistent
        let trade_result = lmsr_api::update_market_probability(
            &pool,
            consistency_event_id,
            users[1].id,
            0.65,
            to_ledger_units(25.0)?
        ).await?;
        
        // Verify data consistency across all tables
        let user_balance: i64 = sqlx::query_scalar(
            "SELECT rp_balance_ledger FROM users WHERE id = $1"
        )
        .bind(users[1].id)
        .fetch_one(&pool)
        .await?;
        
        let user_staked: i64 = sqlx::query_scalar(
            "SELECT rp_staked_ledger FROM users WHERE id = $1"
        )
        .bind(users[1].id)
        .fetch_one(&pool)
        .await?;
        
        let shares_staked: Option<i64> = sqlx::query_scalar(
            "SELECT total_staked_ledger FROM user_shares WHERE user_id = $1 AND event_id = $2"
        )
        .bind(users[1].id)
        .bind(consistency_event_id)
        .fetch_optional(&pool)
        .await?;
        
        let audit_trail_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM market_updates WHERE user_id = $1 AND event_id = $2"
        )
        .bind(users[1].id)
        .bind(consistency_event_id)
        .fetch_one(&pool)
        .await?;
        
        assert!(user_balance >= 0, "User balance should be non-negative");
        assert!(user_staked >= 0, "User staked should be non-negative");
        assert!(shares_staked.unwrap_or(0) > 0, "User should have shares after trade");
        assert!(audit_trail_count > 0, "Audit trail should record the transaction");
        
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
        
        println!("🔢 Starting numerical precision tests...");
        
        // Test 1: Very small stakes (micro-RP precision)
        println!("🔬 Test 1: Micro-RP precision test");
        
        let micro_stake = 0.000001; // 1 micro-RP
        let micro_result = lmsr_api::update_market_probability(
            &pool,
            event_id,
            users[0].id,
            0.50001, // Very small probability change
            to_ledger_units(micro_stake)?
        ).await;
        
        match micro_result {
            Ok(result) => {
                assert!(result.shares_acquired > 0.0, "Should acquire some shares even with micro-stake");
                println!("✅ Micro-stake handled: {} shares acquired", result.shares_acquired);
            },
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
            let result = lmsr_api::update_market_probability(
                &pool,
                event_id,
                users[0].id,
                prob,
                to_ledger_units(1.0)?
            ).await;
            
            match result {
                Ok(_) => println!("✅ Extreme probability {} handled", prob),
                Err(e) => println!("✅ Extreme probability {} rejected: {}", prob, e),
            }
        }
        
        // Test 3: Rounding consistency in buy/sell cycles
        println!("🔄 Test 3: Rounding consistency test");
        
        let initial_balance: i64 = sqlx::query_scalar(
            "SELECT rp_balance_ledger FROM users WHERE id = $1"
        )
        .bind(users[0].id)
        .fetch_one(&pool)
        .await?;
        
        // Perform multiple small buy/sell cycles
        for cycle in 0..10 {
            let stake = 0.1 + (cycle as f64 * 0.01); // Varying small stakes
            
            // Buy shares
            let buy_result = lmsr_api::update_market_probability(
                &pool,
                event_id,
                users[0].id,
                0.6,
                to_ledger_units(stake)?
            ).await?;
            
            // Sell a portion back
            if buy_result.shares_acquired > 0.01 {
                let sell_amount = buy_result.shares_acquired * 0.5;
                let _sell_result = lmsr_api::sell_shares(
                    &pool,
                    users[0].id,
                    event_id,
                    Side::Yes,
                    sell_amount
                ).await?;
            }
        }
        
        let final_balance: i64 = sqlx::query_scalar(
            "SELECT rp_balance_ledger FROM users WHERE id = $1"
        )
        .bind(users[0].id)
        .fetch_one(&pool)
        .await?;
        
        let balance_change = (initial_balance - final_balance) as f64 / 1_000_000.0;
        println!("✅ Balance change after rounding cycles: {:.6} RP", balance_change);
        
        // Balance should have decreased (we paid trading costs) but not by too much
        assert!(balance_change >= 0.0, "Balance should have decreased due to trading");
        assert!(balance_change < 10.0, "Balance change should be reasonable");
        
        println!("✅ All numerical precision tests PASSED");
        cleanup_test_database(pool).await?;
        Ok(())
    }
}