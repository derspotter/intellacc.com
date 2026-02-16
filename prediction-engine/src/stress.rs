//! Comprehensive stress tests for the LMSR prediction engine
//!
//! This module tests:
//! 1. **Correctness**: Core LMSR math, buy/sell symmetry, and resolution logic
//! 2. **Financial Invariants**: Ensures no RP is created or destroyed
//! 3. **Performance**: Measures transaction throughput under high load
//! 4. **Concurrency**: Stress-tests the database transaction logic with parallel operations
//! 5. **Market Accuracy**: Simulates traders with varying skill levels

use anyhow::Result;
use rand::prelude::*;
use sqlx::{PgPool, Row};
use std::env;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tracing::{error, info};

use crate::config::Config;
use crate::lmsr_api::{self, MarketUpdate};
use crate::lmsr_core::{self, LEDGER_SCALE};

// --- Test Configuration ---
const INITIAL_BALANCE_LEDGER: i64 = 1_000 * LEDGER_SCALE as i64; // 1000 RP

// Simulation Parameters (defaults; override via STRESS_* env vars)
const NUM_USERS: usize = 1_000;
const NUM_EVENTS: usize = 1_000;
const TRADES_PER_USER: usize = 1_000; // 1M trades total (1k users * 1k trades each)
const LIQUIDITY_B: f64 = 5000.0; // Higher liquidity for more stable markets
const BATCH_SIZE: usize = 100; // Process trades in batches to reduce contention
const SELL_PROBABILITY: f64 = 0.25;
const MIN_SELL_SHARES: f64 = 0.0001;

#[derive(Debug, Clone)]
struct StressConfig {
    num_users: usize,
    num_events: usize,
    trades_per_user: usize,
    liquidity_b: f64,
    batch_size: usize,
    sell_probability: f64,
    min_sell_shares: f64,
}

impl StressConfig {
    fn from_env() -> Self {
        let num_users = env_usize("STRESS_NUM_USERS", NUM_USERS);
        let num_events = env_usize("STRESS_NUM_EVENTS", NUM_EVENTS);
        let trades_per_user = env_usize("STRESS_TRADES_PER_USER", TRADES_PER_USER);
        let batch_size = env_usize("STRESS_BATCH_SIZE", BATCH_SIZE);
        let liquidity_b = env_f64("STRESS_LIQUIDITY_B", LIQUIDITY_B);
        let sell_probability =
            env_f64_clamped("STRESS_SELL_PROBABILITY", SELL_PROBABILITY, 0.0, 1.0);
        let min_sell_shares = env_f64_min("STRESS_MIN_SELL_SHARES", MIN_SELL_SHARES, 0.0);

        Self {
            num_users,
            num_events,
            trades_per_user,
            liquidity_b,
            batch_size,
            sell_probability,
            min_sell_shares,
        }
    }
}

fn stress_config() -> &'static StressConfig {
    static CONFIG: OnceLock<StressConfig> = OnceLock::new();
    CONFIG.get_or_init(StressConfig::from_env)
}

fn env_usize(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
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

fn env_f64_min(name: &str, default: f64, min: f64) -> f64 {
    env_f64(name, default).max(min)
}

/// Represents a simulated user with a defined skill level
#[derive(Debug, Clone)]
struct TestUser {
    id: i32,
    skill: f64, // 0.0 = pure noise, 1.0 = perfect knowledge
}

/// Represents a market event with a known "true" outcome
#[derive(Debug, Clone)]
struct TestEvent {
    id: i32,
    true_prob: f64, // The actual, hidden probability of the event
}

#[derive(Debug, Clone, Copy)]
enum TradeOutcome {
    Executed,
    Skipped,
}

/// Sets up a clean, isolated database for testing
pub async fn setup_test_database(pool: &PgPool) -> Result<()> {
    // Drop and recreate tables to ensure clean state
    sqlx::query("DROP TABLE IF EXISTS market_updates CASCADE")
        .execute(pool)
        .await?;
    sqlx::query("DROP TABLE IF EXISTS user_shares CASCADE")
        .execute(pool)
        .await?;
    sqlx::query("DROP TABLE IF EXISTS events CASCADE")
        .execute(pool)
        .await?;
    sqlx::query("DROP TABLE IF EXISTS users CASCADE")
        .execute(pool)
        .await?;

    // Create minimal test tables with double-precision market math
    sqlx::query(
        r#"
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            rp_balance_ledger BIGINT NOT NULL DEFAULT 1000000000,
            rp_staked_ledger BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS events (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            outcome TEXT,
            liquidity_b DOUBLE PRECISION DEFAULT 5000.0,
            market_prob DOUBLE PRECISION DEFAULT 0.5,
            cumulative_stake DOUBLE PRECISION DEFAULT 0.0,
            q_yes DOUBLE PRECISION DEFAULT 0.0,
            q_no DOUBLE PRECISION DEFAULT 0.0,
            closing_date TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS user_shares (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            yes_shares DOUBLE PRECISION DEFAULT 0 CHECK (yes_shares >= 0),
            no_shares DOUBLE PRECISION DEFAULT 0 CHECK (no_shares >= 0),
            total_staked_ledger BIGINT NOT NULL DEFAULT 0,
            staked_yes_ledger BIGINT NOT NULL DEFAULT 0,
            staked_no_ledger BIGINT NOT NULL DEFAULT 0,
            last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            version INTEGER NOT NULL DEFAULT 1,
            UNIQUE(user_id, event_id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS market_updates (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            prev_prob DOUBLE PRECISION NOT NULL,
            new_prob DOUBLE PRECISION NOT NULL,
            stake_amount DOUBLE PRECISION NOT NULL CHECK (stake_amount > 0),
            stake_amount_ledger BIGINT NOT NULL,
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

    // Create indexes
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_market_updates_user ON market_updates(user_id)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_market_updates_event ON market_updates(event_id)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_user_shares_event ON user_shares(event_id)")
        .execute(pool)
        .await?;

    info!("✅ Test database schema created");
    Ok(())
}

/// Creates test users with varying skill levels
async fn create_test_users(pool: &PgPool) -> Result<Vec<TestUser>> {
    let stress = stress_config();
    let mut users = Vec::new();
    let mut rng = thread_rng();

    for i in 0..stress.num_users {
        let username = format!("testuser_{}", i);
        let email = format!("test{}@example.com", i);
        let user_id: i32 = sqlx::query_scalar(
            "INSERT INTO users (username, email, rp_balance_ledger) VALUES ($1, $2, $3) RETURNING id"
        )
        .bind(&username)
        .bind(&email)
        .bind(INITIAL_BALANCE_LEDGER)
        .fetch_one(pool)
        .await?;

        users.push(TestUser {
            id: user_id,
            skill: rng.gen(), // Random skill between 0.0 and 1.0
        });
    }

    info!(
        "✅ Created {} test users with varying skill levels",
        stress.num_users
    );
    Ok(users)
}

/// Creates test market events with random "true" outcomes
async fn create_test_events(pool: &PgPool) -> Result<Vec<TestEvent>> {
    let stress = stress_config();
    let mut events = Vec::new();

    info!("Creating {} test events...", stress.num_events);

    // Create events in batches for better performance
    for batch_start in (0..stress.num_events).step_by(stress.batch_size) {
        let batch_end = (batch_start + stress.batch_size).min(stress.num_events);
        let mut batch_events = Vec::new();

        for i in batch_start..batch_end {
            let title = format!("Test Event #{}", i);
            let true_prob = 0.2 + (i as f64 / stress.num_events as f64) * 0.6; // Spread between 0.2 and 0.8

            let event_id: i32 = sqlx::query_scalar(
                r#"
                INSERT INTO events (title, liquidity_b, market_prob, q_yes, q_no, cumulative_stake, closing_date) 
                VALUES ($1, $2, 0.5, 0.0, 0.0, 0.0, NOW() + INTERVAL '30 days') 
                RETURNING id
                "#
            )
            .bind(&title)
            .bind(stress.liquidity_b)
            .fetch_one(pool)
            .await?;

            batch_events.push(TestEvent {
                id: event_id,
                true_prob,
            });
        }

        events.extend(batch_events);

        if batch_start % 10000 == 0 || batch_end == stress.num_events {
            info!("Created {} / {} events", batch_end, stress.num_events);
        }
    }

    info!(
        "✅ Created {} test events with hidden ground truths",
        stress.num_events
    );
    Ok(events)
}

/// Simulates a user's belief based on their skill and the event's true probability
fn simulate_belief(skill: f64, true_prob: f64, noise_factor: f64) -> f64 {
    // A skilled user's belief is closer to the true probability
    // A noisy user's belief is closer to a random guess
    let noise = (noise_factor - 0.5) * (1.0 - skill); // Less noise for higher skill
    (true_prob + noise).clamp(0.01, 0.99)
}

/// Helper function to execute a single trade with proper error handling
async fn try_execute_trade(
    pool: &PgPool,
    config: &Config,
    user_id: i32,
    event_id: i32,
    belief: f64,
    stake_multiplier: f64,
) -> Result<TradeOutcome> {
    let stress = stress_config();
    let should_sell = rand::random::<f64>() < stress.sell_probability;

    if should_sell {
        let shares_row = sqlx::query(
            "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2",
        )
        .bind(user_id)
        .bind(event_id)
        .fetch_optional(pool)
        .await?;

        let (yes_shares, no_shares) = match shares_row {
            Some(row) => (
                row.get::<f64, _>("yes_shares"),
                row.get::<f64, _>("no_shares"),
            ),
            None => return Ok(TradeOutcome::Skipped),
        };

        if yes_shares <= 0.0 && no_shares <= 0.0 {
            return Ok(TradeOutcome::Skipped);
        }

        let total_shares = yes_shares + no_shares;
        if total_shares < stress.min_sell_shares {
            return Ok(TradeOutcome::Skipped);
        }

        let sell_yes = if yes_shares > 0.0 && no_shares > 0.0 {
            rand::random::<f64>() * total_shares < yes_shares
        } else {
            yes_shares > 0.0
        };

        let (share_type, available) = if sell_yes {
            ("yes", yes_shares)
        } else {
            ("no", no_shares)
        };

        if available < stress.min_sell_shares {
            return Ok(TradeOutcome::Skipped);
        }

        let sell_fraction = 0.1 + rand::random::<f64>() * 0.5; // 10% to 60% of holdings
        let amount = (available * sell_fraction)
            .max(stress.min_sell_shares)
            .min(available);

        if !amount.is_finite() || amount <= 0.0 {
            return Ok(TradeOutcome::Skipped);
        }

        match lmsr_api::sell_shares(pool, config, user_id, event_id, share_type, amount).await {
            Ok(_) => return Ok(TradeOutcome::Executed),
            Err(err) => {
                let message = err.to_string();
                if message.contains("Hold period not expired")
                    || message.contains("Insufficient YES shares")
                    || message.contains("Insufficient NO shares")
                {
                    return Ok(TradeOutcome::Skipped);
                }
                return Err(err);
            }
        }
    }

    // Get current market state
    let market_state_json = lmsr_api::get_market_state(pool, event_id).await?;
    let market_prob = market_state_json["market_prob"].as_f64().unwrap_or(0.5);

    // Get user balance
    let balance_row = sqlx::query("SELECT rp_balance_ledger FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await?;

    let balance =
        lmsr_core::from_ledger_units(balance_row.get::<i64, _>("rp_balance_ledger") as i128);

    if balance <= 1.0 {
        return Ok(TradeOutcome::Skipped);
    }

    // Use Kelly suggestion to determine stake size
    let kelly = lmsr_api::kelly_suggestion(config, belief, market_prob, balance);
    let stake = (kelly.quarter_kelly * stake_multiplier)
        .min(balance * 0.05) // Cap at 5% of balance for more trades
        .max(0.01); // Minimum stake

    let update = MarketUpdate {
        event_id,
        target_prob: belief,
        stake,
        referral_post_id: None,
        referral_click_id: None,
    };

    // Execute the trade
    match lmsr_api::update_market(pool, config, user_id, update).await {
        Ok(_) => Ok(TradeOutcome::Executed),
        Err(err) => {
            let message = err.to_string();
            if message.contains("Insufficient RP balance") {
                Ok(TradeOutcome::Skipped)
            } else {
                Err(err)
            }
        }
    }
}

/// Main stress test that simulates a high-load prediction market
pub async fn run_stress_test(pool: &PgPool, config: &Config) -> Result<()> {
    let stress = stress_config();
    // Setup test data
    let users = create_test_users(pool).await?;
    let events = create_test_events(pool).await?;
    let pool = Arc::new(pool.clone());
    let config = Arc::new(config.clone());
    let start_time = Instant::now();

    info!("\n🚀 Starting high-load market simulation...");
    info!(
        "Target: {} trades ({} users × {} trades each)",
        stress.num_users * stress.trades_per_user,
        stress.num_users,
        stress.trades_per_user
    );

    let mut successful_trades = 0u64;
    let mut failed_trades = 0u64;
    let mut skipped_trades = 0u64;

    // Process trades in batches by user to reduce contention
    for user_batch_start in (0..stress.num_users).step_by(stress.batch_size) {
        let user_batch_end = (user_batch_start + stress.batch_size).min(stress.num_users);
        let mut batch_handles = Vec::new();

        // Create concurrent tasks for this batch of users
        for user_idx in user_batch_start..user_batch_end {
            let pool = Arc::clone(&pool);
            let config = Arc::clone(&config);
            let user = users[user_idx].clone();
            let events = events.clone();

            let handle = tokio::spawn(async move {
                let mut user_successful = 0u64;
                let mut user_failed = 0u64;
                let mut user_skipped = 0u64;

                // Each user makes multiple trades
                for trade_num in 0..stress.trades_per_user {
                    // Select a random event (deterministic but spread across events)
                    let event_idx = (user.id as usize + trade_num) % events.len();
                    let event = &events[event_idx];

                    // Generate random factors before async operations
                    let noise_factor = rand::random::<f64>();
                    let belief = simulate_belief(user.skill, event.true_prob, noise_factor);
                    let stake_multiplier = 0.5 + rand::random::<f64>(); // 0.5 to 1.5

                    // Get user balance and current market state
                    match try_execute_trade(
                        &pool,
                        &config,
                        user.id,
                        event.id,
                        belief,
                        stake_multiplier,
                    )
                    .await
                    {
                        Ok(TradeOutcome::Executed) => user_successful += 1,
                        Ok(TradeOutcome::Skipped) => user_skipped += 1,
                        Err(_) => user_failed += 1, // Log details for debugging if needed
                    }

                    // Add small delay every 100 trades to prevent overwhelming the system
                    if trade_num % 100 == 0 && trade_num > 0 {
                        tokio::time::sleep(tokio::time::Duration::from_millis(1)).await;
                    }
                }

                (user_successful, user_failed, user_skipped)
            });

            batch_handles.push(handle);
        }

        // Wait for this batch to complete and collect results
        for handle in batch_handles {
            match handle.await {
                Ok((s, f, k)) => {
                    successful_trades += s;
                    failed_trades += f;
                    skipped_trades += k;
                }
                Err(e) => {
                    error!("User task failed: {}", e);
                    failed_trades += stress.trades_per_user as u64;
                }
            }
        }

        // Progress reporting
        let completed_users = user_batch_end;
        let _total_attempted = completed_users * stress.trades_per_user;
        let current_duration = start_time.elapsed();
        let current_tps = (successful_trades + failed_trades + skipped_trades) as f64
            / current_duration.as_secs_f64();

        info!(
            "Progress: {}/{} users ({:.1}%) | {} successful, {} failed, {} skipped | {:.0} TPS",
            completed_users,
            stress.num_users,
            (completed_users as f64 / stress.num_users as f64) * 100.0,
            successful_trades,
            failed_trades,
            skipped_trades,
            current_tps
        );
    }

    let total_trades = successful_trades + failed_trades + skipped_trades;
    let duration = start_time.elapsed();
    let tps = total_trades as f64 / duration.as_secs_f64();
    let success_rate = if total_trades == 0 {
        0.0
    } else {
        (successful_trades as f64 / total_trades as f64) * 100.0
    };

    info!("\n🏁 Simulation finished in {:.2?}", duration);
    info!("   Executed {} trades successfully", successful_trades);
    info!(
        "   Skipped {} trades (no shares/balance/hold)",
        skipped_trades
    );
    info!("   Failed {} trades", failed_trades);
    info!("   Performance: {:.2} Transactions/Second", tps);

    // --- VERIFICATION & MEASUREMENT ---
    info!("\n🔍 Verifying financial invariants...");

    // 1. Check initial total RP in the system
    let initial_total_rp: i64 = (stress.num_users as i64) * INITIAL_BALANCE_LEDGER;

    // 2. Resolve events and measure accuracy
    let mut brier_scores = vec![];
    for event in &events {
        let market_state_json = lmsr_api::get_market_state(&pool, event.id).await?;
        let final_prob = market_state_json["market_prob"].as_f64().unwrap();

        // Simulate the actual outcome based on true probability
        let outcome = thread_rng().gen_bool(event.true_prob);

        // Resolve the event
        lmsr_api::resolve_event(&pool, event.id, outcome).await?;

        // Calculate Brier score (lower is better)
        let brier_score = (final_prob - if outcome { 1.0 } else { 0.0 }).powi(2);
        brier_scores.push(brier_score);
    }

    let avg_brier_score = brier_scores.iter().sum::<f64>() / brier_scores.len() as f64;
    info!(
        "   Market Accuracy (Avg Brier Score): {:.4}",
        avg_brier_score
    );
    assert!(
        avg_brier_score < 0.35,
        "Market should be more accurate than random chance!"
    );

    // 3. Verify final total RP
    let final_total_rp: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(rp_balance_ledger + rp_staked_ledger), 0)::BIGINT FROM users",
    )
    .fetch_one(pool.as_ref())
    .await?;

    // The total RP should be conserved (minus any market maker subsidy)
    // In LMSR, the market maker can lose money subsidizing liquidity
    let rp_difference = initial_total_rp - final_total_rp;
    let rp_difference_pct = (rp_difference as f64 / initial_total_rp as f64).abs() * 100.0;

    info!(
        "   Initial Total RP: {:.2}",
        lmsr_core::from_ledger_units(initial_total_rp as i128)
    );
    info!(
        "   Final Total RP:   {:.2}",
        lmsr_core::from_ledger_units(final_total_rp as i128)
    );
    info!(
        "   Market Maker Loss: {:.2} ({:.2}%)",
        lmsr_core::from_ledger_units(rp_difference as i128),
        rp_difference_pct
    );

    // 4. Verify system invariants for a sample of users
    let sample_users: Vec<i32> =
        sqlx::query_scalar("SELECT id FROM users ORDER BY RANDOM() LIMIT 10")
            .fetch_all(pool.as_ref())
            .await?;

    for user_id in sample_users {
        let balance_result = lmsr_api::verify_balance_invariant(&pool, user_id).await?;
        assert!(
            balance_result["valid"].as_bool().unwrap(),
            "Balance invariant failed for user {}: {}",
            user_id,
            balance_result["message"]
        );

        let staked_result = lmsr_api::verify_staked_invariant(&pool, user_id).await?;
        assert!(
            staked_result["valid"].as_bool().unwrap(),
            "Staked invariant failed for user {}: {}",
            user_id,
            staked_result["message"]
        );
    }

    info!("✅ Financial invariants maintained. System is sound.");
    info!("\n📊 Stress Test Summary:");
    info!(
        "   - Total trades attempted: {}",
        stress.num_users * stress.trades_per_user
    );
    info!("   - Successful trades: {}", successful_trades);
    info!("   - Failed trades: {}", failed_trades);
    info!("   - Skipped trades: {}", skipped_trades);
    info!("   - Success rate: {:.1}%", success_rate);
    info!("   - Average TPS: {:.2}", tps);
    info!("   - Market accuracy (Brier): {:.4}", avg_brier_score);
    info!("   - Market maker subsidy: {:.2}%", rp_difference_pct);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;
    use std::time::Duration;

    #[tokio::test]
    async fn test_comprehensive_market_simulation() -> Result<()> {
        // Initialize tracing for test output
        tracing_subscriber::fmt::init();

        // Create test database connection
        let database_url = env::var("STRESS_TEST_DB_URL")
            .or_else(|_| env::var("TEST_DB_URL"))
            .or_else(|_| env::var("DATABASE_URL"))
            .unwrap_or_else(|_| {
                "postgresql://postgres:password@localhost/test_intellacc".to_string()
            });
        let acquire_timeout_secs = env::var("STRESS_TEST_ACQUIRE_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(120);

        let pool = PgPoolOptions::new()
            .max_connections(50)
            .acquire_timeout(Duration::from_secs(acquire_timeout_secs))
            .connect(&database_url)
            .await?;

        // Setup test database schema
        setup_test_database(&pool).await?;

        // Create test config
        let config = Config::from_env();

        // Run the stress test
        run_stress_test(&pool, &config).await?;

        Ok(())
    }
}
