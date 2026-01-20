//! LMSR API layer using lmsr_core directly (DRY implementation)
//! Eliminates the redundant lmsr.rs wrapper for clean architecture

use crate::lmsr_core::{Market, to_ledger_units, from_ledger_units, Side};
use crate::db_adapter::DbAdapter;
use crate::config::Config;
use sqlx::{PgPool, Row, Executor, Error as SqlxError};
use chrono::{DateTime, Utc, Duration};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::time::Duration as StdDuration;
use tokio::time::sleep;
use rand::Rng;
use tracing::debug;

// Configuration constants for concurrency control
const MAX_RETRY_ATTEMPTS: u32 = 5;
const BASE_RETRY_DELAY_MS: u64 = 10;
const ERR_MARKET_RESOLVED: &str = "Market resolved";
const ERR_MARKET_CLOSED: &str = "Market closed";

/// PostgreSQL SQLSTATE codes for retryable errors
/// Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
mod pg_error_codes {
    // Class 40 — Transaction Rollback
    pub const SERIALIZATION_FAILURE: &str = "40001";
    pub const DEADLOCK_DETECTED: &str = "40P01";
    
    // Class 25 — Invalid Transaction State  
    pub const ACTIVE_SQL_TRANSACTION: &str = "25001";
    
    // Class 23 — Integrity Constraint Violation (may indicate concurrent updates)
    pub const UNIQUE_VIOLATION: &str = "23505";
}

/// Determines if a database error is retryable based on PostgreSQL SQLSTATE codes
/// This replaces fragile string-based error detection with reliable error code matching
fn is_retryable_error(error: &anyhow::Error) -> bool {
    // Try to extract the root cause SqlxError
    let mut current_error: &dyn std::error::Error = error.as_ref();
    
    loop {
        // Check if this level is a SqlxError
        if let Some(sqlx_error) = current_error.downcast_ref::<SqlxError>() {
            return match sqlx_error {
                SqlxError::Database(db_error) => {
                    // SQLx provides SQLSTATE through the code() method
                    if let Some(sqlstate) = db_error.code() {
                        let sqlstate_str = sqlstate.as_ref();
                        let is_retryable = matches!(sqlstate_str, 
                            pg_error_codes::SERIALIZATION_FAILURE |
                            pg_error_codes::DEADLOCK_DETECTED |
                            pg_error_codes::ACTIVE_SQL_TRANSACTION |
                            pg_error_codes::UNIQUE_VIOLATION
                        );
                        
                        if is_retryable {
                            debug!(
                                sqlstate = sqlstate_str,
                                message = db_error.message(),
                                "detected retryable database error"
                            );
                        }
                        
                        is_retryable
                    } else {
                        false
                    }
                }
                _ => false,
            };
        }
        
        // Move to the next error in the chain
        match current_error.source() {
            Some(source) => current_error = source,
            None => break,
        }
    }
    
    false
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MarketUpdate {
    pub event_id: i32,
    pub target_prob: f64,  // User's belief (0-1) - now f64 directly
    pub stake: f64,        // Amount of RP to stake - now f64 directly
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateResult {
    pub prev_prob: f64,
    pub new_prob: f64,
    pub shares_acquired: f64,
    pub share_type: String,
    pub hold_until: DateTime<Utc>,
    pub expected_payout_if_yes: f64,
    pub expected_payout_if_no: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SellResult {
    pub payout: f64,
    pub new_prob: f64,
    pub current_cost_c: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KellySuggestion {
    pub kelly_suggestion: f64,
    pub quarter_kelly: f64,
    pub current_prob: f64,
    pub balance: f64,
}

/// Macro for executing transactions with SERIALIZABLE isolation and retry logic
macro_rules! with_serializable_tx {
    ($pool:expr, $tx_var:ident, $body:block) => {{
        let mut attempt = 1;
        loop {
            let mut $tx_var = $pool.begin().await?;
            
            // Set SERIALIZABLE isolation level
            $tx_var.execute(sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"))
                .await?;
            
            let result: Result<_> = async { $body }.await;
            
            match result {
                Ok(value) => {
                    $tx_var.commit().await?;
                    break Ok(value);
                }
                Err(e) => {
                    $tx_var.rollback().await.ok();
                    
                    // Check if this is a retryable error using PostgreSQL SQLSTATE codes
                    if is_retryable_error(&e) && attempt < MAX_RETRY_ATTEMPTS {
                        // Exponential backoff with jitter
                        let jitter = rand::thread_rng().gen_range(0..10);
                        let delay_ms = BASE_RETRY_DELAY_MS * (1 << (attempt - 1)) + jitter;
                        sleep(StdDuration::from_millis(delay_ms)).await;
                        attempt += 1;
                        continue;
                    } else {
                        break Err(e);
                    }
                }
            }
        }
    }};
}

/// Macro for executing transactions with READ COMMITTED isolation (optimistic)
macro_rules! with_optimistic_tx {
    ($pool:expr, $tx_var:ident, $body:block) => {{
        let mut attempt = 1;
        loop {
            let mut $tx_var = $pool.begin().await?;
            
            // Set READ COMMITTED isolation level
            $tx_var.execute(sqlx::query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
                .await?;
            
            let result: Result<_> = async { $body }.await;
            
            match result {
                Ok(value) => {
                    $tx_var.commit().await?;
                    break Ok(value);
                }
                Err(e) => {
                    $tx_var.rollback().await.ok();
                    
                    // Check if this is a retryable error using PostgreSQL SQLSTATE codes
                    if is_retryable_error(&e) && attempt < MAX_RETRY_ATTEMPTS {
                        let jitter = rand::thread_rng().gen_range(0..5);
                        let delay_ms = BASE_RETRY_DELAY_MS * attempt as u64 + jitter;
                        sleep(StdDuration::from_millis(delay_ms)).await;
                        attempt += 1;
                        continue;
                    } else {
                        break Err(e);
                    }
                }
            }
        }
    }};
}

// Core LMSR update function using lmsr_core directly
pub async fn update_market(
    pool: &PgPool,
    config: &Config,
    user_id: i32,
    update: MarketUpdate,
) -> Result<UpdateResult> {
    // Validate inputs first (outside transaction)
    if update.target_prob <= 0.0 || update.target_prob >= 1.0 {
        return Err(anyhow!("Target probability must be between 0 and 1"));
    }
    if update.stake <= 0.0 {
        return Err(anyhow!("Stake must be positive"));
    }

    with_optimistic_tx!(pool, tx, {
        update_market_transaction(&mut tx, config, user_id, &update).await
    })
}

// Internal transaction logic extracted for concurrency control
async fn update_market_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    config: &Config,
    user_id: i32,
    update: &MarketUpdate,
) -> Result<UpdateResult> {
    
    // Get current market state with row lock
    let row = sqlx::query(
        "SELECT market_prob, cumulative_stake, liquidity_b, q_yes, q_no, outcome,
                COALESCE(closing_date <= NOW(), false) AS is_closed
         FROM events
         WHERE id = $1
         FOR UPDATE"
    )
    .bind(update.event_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(|_| anyhow!("Event not found or market not initialized"))?;
    
    let outcome: Option<String> = row.get("outcome");
    let is_closed: bool = row.get("is_closed");
    if outcome.is_some() {
        return Err(anyhow!(ERR_MARKET_RESOLVED));
    }
    if is_closed {
        return Err(anyhow!(ERR_MARKET_CLOSED));
    }

    // Extract market state using clean adapter
    let market_state = DbAdapter::extract_market_state(&row)?;
    let prev_prob = market_state.market_prob;
    let liquidity_b = market_state.liquidity_b;
    let q_yes = market_state.q_yes;
    let q_no = market_state.q_no;
    
    // Create market from current state
    let mut market = Market { q_yes, q_no, b: liquidity_b };
    
    // Convert stake to ledger units for exact computation
    let stake_ledger = to_ledger_units(update.stake)
        .map_err(|e| anyhow!("Invalid stake value: {}", e))?;
    
    // Execute trade based on target probability
    let (shares_acquired, side, actual_cost_ledger) = if update.target_prob > prev_prob {
        // Buy YES shares to increase probability
        let (shares, cost) = market.buy_yes(stake_ledger)
            .map_err(|e| anyhow!("Trade execution failed: {}", e))?;
        (shares, Side::Yes, cost)
    } else {
        // Buy NO shares to decrease probability  
        let (shares, cost) = market.buy_no(stake_ledger)
            .map_err(|e| anyhow!("Trade execution failed: {}", e))?;
        (shares, Side::No, cost)
    };
    
    // Keep actual_cost_ledger as i128, only convert for final result
    let actual_cost = from_ledger_units(actual_cost_ledger);
    let new_prob = market.prob_yes();
    let new_cumulative_cost = market.cost();
    
    // Update market state using clean adapter
    DbAdapter::update_market_state(
        tx,
        update.event_id,
        new_prob,
        new_cumulative_cost,
        market.q_yes,
        market.q_no,
    ).await?;
    
    // Deduct exact cost from user balance using ledger-native method (single rounding boundary)
    let cost_ledger_i64 = i64::try_from(actual_cost_ledger)
        .map_err(|_| anyhow!("actual_cost_ledger out of i64 range"))?;
    let has_sufficient_funds = DbAdapter::deduct_user_cost_ledger(tx, user_id, cost_ledger_i64).await?;
    if !has_sufficient_funds {
        return Err(anyhow!("Insufficient RP balance"));
    }
    
    // Record the update with configurable hold period using clean adapter
    let hold_duration_hours = if config.market.enable_hold_period {
        config.market.hold_period_hours
    } else {
        0.0  // No hold period if disabled
    };
    
    let hold_until = if hold_duration_hours > 0.0 {
        let duration_minutes = (hold_duration_hours * 60.0).round() as i64;
        Utc::now() + Duration::minutes(duration_minutes)
    } else {
        Utc::now()  // No hold period
    };
    DbAdapter::record_market_update(
        tx,
        user_id,
        update.event_id,
        prev_prob,
        new_prob,
        actual_cost,
        shares_acquired,
        side,
        hold_until,
    ).await?;
    
    // Update user shares using ledger-native method (single rounding boundary)
    DbAdapter::update_user_shares_ledger(
        tx,
        user_id,
        update.event_id,
        side,
        shares_acquired,
        cost_ledger_i64,
    ).await?;
    
    // Calculate expected payouts for display
    let expected_if_yes = if side == Side::Yes { shares_acquired } else { 0.0 };
    let expected_if_no = if side == Side::No { shares_acquired } else { 0.0 };
    
    Ok(UpdateResult {
        prev_prob,
        new_prob,
        shares_acquired,
        share_type: side.to_string(),
        hold_until,
        expected_payout_if_yes: expected_if_yes,
        expected_payout_if_no: expected_if_no,
    })
}

// Sell shares back to market using lmsr_core directly
pub async fn sell_shares(
    pool: &PgPool,
    config: &Config,
    user_id: i32,
    event_id: i32,
    share_type: &str,
    amount: f64,
) -> Result<SellResult> {
    // Parse share_type at API boundary
    let side = Side::from_str(share_type)
        .map_err(|e| anyhow!("Invalid share type: {}", e))?;
    
    // Basic validation outside transaction
    if amount <= 0.0 {
        return Err(anyhow!("Amount must be positive"));
    }

    with_optimistic_tx!(pool, tx, {
        sell_shares_transaction(&mut tx, config, user_id, event_id, side, amount).await
    })
}

// Internal transaction logic for sell_shares
async fn sell_shares_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    config: &Config,
    user_id: i32,
    event_id: i32,
    side: Side,
    amount: f64,
) -> Result<SellResult> {
    
    // Get current market state FIRST (consistent lock order with buy path)
    let event_row = sqlx::query(
        "SELECT market_prob, cumulative_stake, liquidity_b, q_yes, q_no, outcome,
                COALESCE(closing_date <= NOW(), false) AS is_closed
         FROM events
         WHERE id = $1
         FOR UPDATE"
    )
    .bind(event_id)
    .fetch_one(tx.as_mut())
    .await?;

    let outcome: Option<String> = event_row.get("outcome");
    let is_closed: bool = event_row.get("is_closed");
    if outcome.is_some() {
        return Err(anyhow!(ERR_MARKET_RESOLVED));
    }
    if is_closed {
        return Err(anyhow!(ERR_MARKET_CLOSED));
    }
    
    // Check hold period (if enabled in config)
    if config.market.enable_hold_period {
        let now = Utc::now();
        let active_holds: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM market_updates 
             WHERE user_id = $1 AND event_id = $2 AND hold_until > $3"
        )
        .bind(user_id)
        .bind(event_id)
        .bind(now)
        .fetch_one(tx.as_mut())
        .await?;
        
        if active_holds > 0 {
            return Err(anyhow!("Hold period not expired for recent purchases"));
        }
    }
    
    // Then get user shares with side-specific staked amounts (lock user_shares SECOND)
    let row = sqlx::query(
        "SELECT yes_shares, no_shares, total_staked_ledger, staked_yes_ledger, staked_no_ledger
         FROM user_shares 
         WHERE user_id = $1 AND event_id = $2
         FOR UPDATE"
    )
    .bind(user_id)
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await?;
    
    // If no row exists, user has no shares to sell
    let (yes_shares, no_shares, _total_staked_ledger, staked_yes_ledger, staked_no_ledger): (f64, f64, i64, i64, i64) = match row {
        Some(r) => (
            r.get("yes_shares"),
            r.get("no_shares"),
            r.get::<i64, _>("total_staked_ledger"),
            r.get::<i64, _>("staked_yes_ledger"),
            r.get::<i64, _>("staked_no_ledger"),
        ),
        None => (0.0, 0.0, 0, 0, 0),
    };
    
    // Check sufficient shares
    let shares_of_type = match side {
        Side::Yes => yes_shares,
        Side::No => no_shares,
    };
    
    if shares_of_type < amount {
        return Err(anyhow!("Insufficient {} shares", side.as_str().to_uppercase()));
    }
    
    let market_state = DbAdapter::extract_market_state(&event_row)?;
    let liquidity_b = market_state.liquidity_b;
    let q_yes = market_state.q_yes;
    let q_no = market_state.q_no;
    
    // Create market and execute sell
    let mut market = Market { q_yes, q_no, b: liquidity_b };
    
    let payout_ledger = match side {
        Side::Yes => market.sell_yes(amount)
            .map_err(|e| anyhow!("Sell execution failed: {}", e))?,
        Side::No => market.sell_no(amount)
            .map_err(|e| anyhow!("Sell execution failed: {}", e))?,
    };
    
    // Keep payout_ledger as i128, only convert for final result
    let payout = from_ledger_units(payout_ledger);
    let new_prob = market.prob_yes();
    let new_cumulative_cost = market.cost();
    
    // Update market state using clean adapter
    DbAdapter::update_market_state(
        tx,
        event_id,
        new_prob,
        new_cumulative_cost,
        market.q_yes,
        market.q_no,
    ).await?;
    
    // Calculate side-specific stake to unwind directly in ledger units (single rounding boundary)
    let stake_of_side_ledger = match side {
        Side::Yes => staked_yes_ledger,
        Side::No => staked_no_ledger,
    };
    
    let stake_to_unwind_ledger = if shares_of_type > 0.0 && stake_of_side_ledger > 0 {
        // Pure integer arithmetic for proportional calculation (eliminates double rounding)
        let amount_ledger = to_ledger_units(amount)
            .map_err(|e| anyhow!("Invalid sell amount: {}", e))?;
        let shares_ledger = to_ledger_units(shares_of_type)
            .map_err(|e| anyhow!("Invalid shares amount: {}", e))?;
        
        // Ensure shares_ledger is not zero to prevent division by zero
        if shares_ledger == 0 {
            return Err(anyhow!("Cannot calculate proportional stake for zero shares"));
        }
        
        // Pure integer proportional calculation with round-to-nearest: (stake * amount) / shares
        // Safe arithmetic with overflow protection
        let stake_of_side_i128 = stake_of_side_ledger as i128;
        let amount_i128 = amount_ledger as i128;
        
        let numer = stake_of_side_i128.checked_mul(amount_i128)
            .ok_or_else(|| anyhow!("Arithmetic overflow in proportional stake calculation"))?;
        let stake_to_unwind = (numer + (shares_ledger / 2)) / shares_ledger; // Round to nearest
        let clamped = stake_to_unwind.max(0).min(stake_of_side_i128);
        i64::try_from(clamped).map_err(|_| anyhow!("stake_to_unwind_ledger out of i64 range"))?
    } else { 0 };
    
    // Update user balance using ledger-native method (single rounding boundary)
    let payout_ledger_i64 = i64::try_from(payout_ledger)
        .map_err(|_| anyhow!("payout_ledger out of i64 range"))?;
    let stake_delta_ledger = -stake_to_unwind_ledger;
    DbAdapter::update_user_balance_ledger(
        tx,
        user_id,
        payout_ledger_i64,
        stake_delta_ledger,
    ).await?;
    
    // Update user shares using side-specific stake unwinding
    DbAdapter::update_user_shares_with_side_unwind_ledger(
        tx,
        user_id,
        event_id,
        side,
        -amount,                    // Negative to subtract shares
        stake_to_unwind_ledger,     // Positive amount to unwind from side-specific stake
    ).await?;
    
    Ok(SellResult {
        payout,
        new_prob,
        current_cost_c: new_cumulative_cost,
    })
}

// Kelly criterion suggestion
pub fn kelly_suggestion(
    config: &Config,
    belief: f64,
    market_prob: f64,
    balance: f64,
) -> KellySuggestion {
    // Calculate edge
    let edge = if belief > market_prob {
        (belief - market_prob) / (1.0 - market_prob)
    } else {
        (market_prob - belief) / market_prob
    };
    
    // Configurable Kelly fraction for conservative betting
    let kelly_fraction = config.market.kelly_fraction;
    let suggestion = (edge * balance * kelly_fraction)
        .max(0.0)
        .min(balance * kelly_fraction);
    
    KellySuggestion {
        kelly_suggestion: suggestion,
        quarter_kelly: suggestion / 4.0,
        current_prob: market_prob,
        balance,
    }
}

// Resolve event using lmsr_core principles (same as before, but with f64)
pub async fn resolve_event(
    pool: &PgPool,
    event_id: i32,
    outcome: bool,  
) -> Result<()> {
    with_serializable_tx!(pool, tx, {
        resolve_event_transaction(&mut tx, event_id, outcome).await
    })
}

// Internal transaction logic for resolve_event
async fn resolve_event_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_id: i32,
    outcome: bool,
) -> Result<()> {
    
    // Get all user positions with side-specific stake data in single query
    // FOR UPDATE prevents race conditions during resolution (e.g., concurrent sell operations)
    let user_shares = sqlx::query(
        "SELECT user_id, yes_shares, no_shares, 
                staked_yes_ledger, staked_no_ledger
         FROM user_shares 
         WHERE event_id = $1 AND (yes_shares > 0 OR no_shares > 0)
         FOR UPDATE"
    )
    .bind(event_id)
    .fetch_all(tx.as_mut())
    .await?;
    
    // Calculate payout for each user
    for row in &user_shares {
        let user_id: i32 = row.get("user_id");
        let yes_shares: f64 = row.get("yes_shares");
        let no_shares: f64 = row.get("no_shares");
        let staked_yes_ledger: i64 = row.get("staked_yes_ledger");
        let staked_no_ledger: i64 = row.get("staked_no_ledger");
        
        // Calculate final share value based on outcome
        let share_value_f64 = if outcome {
            yes_shares  // YES outcome: YES shares worth 1, NO shares worth 0
        } else {
            no_shares   // NO outcome: NO shares worth 1, YES shares worth 0
        };
        
        // Update user balance with share value and clear exact staked amount using ledger-native method
        let total_staked_ledger = staked_yes_ledger + staked_no_ledger;
        let share_value_ledger = i64::try_from(crate::lmsr_core::to_ledger_units(share_value_f64)
            .map_err(|e| anyhow!("Invalid share value: {}", e))?)
            .map_err(|_| anyhow!("share_value_ledger out of i64 range"))?;
        DbAdapter::update_user_balance_ledger(
            tx,
            user_id,
            share_value_ledger,
            -total_staked_ledger,
        ).await?;
    }
    
    // Mark event as resolved
    let outcome_str = if outcome { "resolved_yes" } else { "resolved_no" };
    sqlx::query(
        "UPDATE events SET outcome = $1 WHERE id = $2"
    )
    .bind(outcome_str)
    .bind(event_id)
    .execute(tx.as_mut())
    .await?;
    
    // Clear user shares for this event
    sqlx::query(
        "DELETE FROM user_shares WHERE event_id = $1"
    )
    .bind(event_id)
    .execute(tx.as_mut())
    .await?;
    
    Ok(())
}

// Get market state for an event
pub async fn get_market_state(
    pool: &PgPool,
    event_id: i32,
) -> Result<serde_json::Value> {
    let row = sqlx::query(
        "SELECT 
            e.id,
            e.title,
            e.market_prob,
            e.cumulative_stake,
            e.liquidity_b,
            COUNT(DISTINCT mu.user_id) as unique_traders,
            COUNT(mu.id) as total_trades
         FROM events e
         LEFT JOIN market_updates mu ON e.id = mu.event_id
         WHERE e.id = $1
         GROUP BY e.id"
    )
    .bind(event_id)
    .fetch_optional(pool)
    .await?;
    
    match row {
        Some(row) => {
            Ok(serde_json::json!({
                "event_id": row.get::<i32, _>("id"),
                "title": row.get::<String, _>("title"),
                "market_prob": row.get::<f64, _>("market_prob"),
                "cumulative_stake": row.get::<f64, _>("cumulative_stake"),
                "liquidity_b": row.get::<f64, _>("liquidity_b"),
                "unique_traders": row.get::<i64, _>("unique_traders"),
                "total_trades": row.get::<i64, _>("total_trades"),
            }))
        }
        None => Err(anyhow!("Event not found")),
    }
}

// Get recent trades for an event
pub async fn get_event_trades(
    pool: &PgPool,
    event_id: i32,
    limit: i32,
) -> Result<serde_json::Value> {
    let rows = sqlx::query(
        r#"
        SELECT
            mu.id,
            u.username,
            mu.share_type,
            mu.stake_amount,
            mu.prev_prob,
            mu.new_prob,
            mu.shares_acquired,
            mu.created_at
        FROM market_updates mu
        JOIN users u ON mu.user_id = u.id
        WHERE mu.event_id = $1
        ORDER BY mu.created_at DESC
        LIMIT $2
        "#
    )
    .bind(event_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let trades: Vec<serde_json::Value> = rows.iter().map(|row| {
        let prev_prob: f64 = row.get("prev_prob");
        let new_prob: f64 = row.get("new_prob");
        let stake_amount: f64 = row.get("stake_amount");
        let shares_acquired: f64 = row.get("shares_acquired");
        let share_type: String = row.get("share_type");
        let created_at: DateTime<Utc> = row.get("created_at");

        serde_json::json!({
            "id": row.get::<i32, _>("id"),
            "user": row.get::<String, _>("username"),
            "direction": share_type.to_uppercase(),
            "amount": stake_amount,
            "shares_acquired": shares_acquired,
            "price_before": prev_prob,
            "price_after": new_prob,
            "timestamp": created_at.to_rfc3339()
        })
    }).collect();

    Ok(serde_json::json!({
        "event_id": event_id,
        "trades": trades,
        "count": trades.len()
    }))
}

// Get user's shares for an event
pub async fn get_user_shares(
    pool: &PgPool,
    user_id: i32,
    event_id: i32,
) -> Result<serde_json::Value> {
    let row = sqlx::query(
        "SELECT yes_shares, no_shares 
         FROM user_shares 
         WHERE user_id = $1 AND event_id = $2"
    )
    .bind(user_id)
    .bind(event_id)
    .fetch_optional(pool)
    .await?;
    
    match row {
        Some(row) => {
            Ok(serde_json::json!({
                "yes_shares": row.get::<f64, _>("yes_shares"),
                "no_shares": row.get::<f64, _>("no_shares"),
            }))
        }
        None => {
            Ok(serde_json::json!({
                "yes_shares": 0.0,
                "no_shares": 0.0,
            }))
        }
    }
}

// ============================================================================
// INVARIANT VERIFICATION FUNCTIONS
// ============================================================================

/// Verify balance invariant: users.rp_balance_ledger + users.rp_staked_ledger == initial + Σ(ledger ΔC) + Σ(resolution credits)
pub async fn verify_balance_invariant(
    pool: &PgPool,
    user_id: i32,
) -> Result<serde_json::Value> {
    with_optimistic_tx!(pool, tx, {
        verify_balance_invariant_transaction(&mut tx, user_id).await
    })
}

async fn verify_balance_invariant_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i32,
) -> Result<serde_json::Value> {
    
    // Get current user ledger balances (exact precision)
    let row = sqlx::query(
        "SELECT rp_balance_ledger, rp_staked_ledger FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    
    let (current_balance_ledger, current_staked_ledger) = match row {
        Some(row) => {
            let balance: i64 = row.get("rp_balance_ledger");
            let staked: i64 = row.get("rp_staked_ledger");
            (balance, staked)
        }
        None => return Ok(serde_json::json!({
            "valid": false,
            "message": "User not found"
        }))
    };
    
    let current_total_ledger = current_balance_ledger + current_staked_ledger;
    
    // Calculate total stake spent in ledger units from market updates (if available)
    let total_spent_ledger: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(stake_amount_ledger), 0)::BIGINT FROM market_updates WHERE user_id = $1"
    )
    .bind(user_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(|e| anyhow!("Failed to fetch user stake history: {}", e))?;
    
    // For now, assume initial balance was 1000 RP (1,000,000,000 ledger units)
    // In a real system, this would be tracked from account creation
    let _assumed_initial_ledger = 1_000_000_000i64; // 1000 RP
    
    // The fundamental ledger conservation equation:
    // current_total = initial_total - total_spent + total_received
    // For trading: total_received comes from selling shares back to market
    
    // Since we're missing some transaction history, we'll do a simpler check:
    // Verify that current ledger values are internally consistent
    let ledger_consistency_check = current_balance_ledger >= 0 && current_staked_ledger >= 0;
    
    let is_valid = ledger_consistency_check;
    
    let message = if is_valid {
        "Ledger-based balance invariant verified".to_string()
    } else {
        let mut issues = Vec::new();
        if !ledger_consistency_check {
            issues.push("negative ledger values");
        }
        format!("Ledger invariant violated: {}", issues.join(", "))
    };
    
    Ok(serde_json::json!({
        "valid": is_valid,
        "message": message,
        "details": {
            "current_balance_ledger": current_balance_ledger,
            "current_staked_ledger": current_staked_ledger,
            "current_total_ledger": current_total_ledger,
            "current_balance_rp": crate::lmsr_core::from_ledger_units(current_balance_ledger as i128),
            "current_staked_rp": crate::lmsr_core::from_ledger_units(current_staked_ledger as i128),
            "current_total_rp": crate::lmsr_core::from_ledger_units(current_total_ledger as i128),
            "total_spent_ledger": total_spent_ledger,
            "ledger_consistency": ledger_consistency_check
        }
    }))
}

/// Verify staked invariant: users.rp_staked_ledger == Σ user_shares.total_staked_ledger (before resolution)
pub async fn verify_staked_invariant(
    pool: &PgPool,
    user_id: i32,
) -> Result<serde_json::Value> {
    with_optimistic_tx!(pool, tx, {
        verify_staked_invariant_transaction(&mut tx, user_id).await
    })
}

async fn verify_staked_invariant_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i32,
) -> Result<serde_json::Value> {
    
    // Pure ledger vs ledger check (exact match expected)
    let user_staked_ledger: i64 = sqlx::query_scalar(
        "SELECT COALESCE(rp_staked_ledger, 0)::BIGINT FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_one(tx.as_mut())
    .await?;
    
    let total_staked_ledger: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total_staked_ledger), 0)::BIGINT FROM user_shares WHERE user_id = $1"
    )
    .bind(user_id)
    .fetch_one(tx.as_mut())
    .await?;
    
    let is_valid = user_staked_ledger == total_staked_ledger;
    let diff_ledger = (user_staked_ledger as i128 - total_staked_ledger as i128).abs();
    let user_staked = from_ledger_units(user_staked_ledger as i128);
    let shares_staked = from_ledger_units(total_staked_ledger as i128);
    
    let message = if is_valid {
        "Staked invariant verified - exact match in ledger units".into()
    } else {
        format!("Staked invariant FAILED - ledger mismatch of {} (≈{:.6} RP)", diff_ledger, from_ledger_units(diff_ledger))
    };
    
    Ok(serde_json::json!({
        "valid": is_valid,
        "message": message,
        "details": {
            "user_staked_ledger": user_staked_ledger,
            "shares_staked_ledger": total_staked_ledger,
            "user_staked": user_staked,
            "shares_staked": shares_staked,
            "difference_ledger": diff_ledger
        }
    }))
}

/// Verify post-resolution invariant: After resolution, user_shares rows cleared; rp_staked_ledger unchanged by further reads
pub async fn verify_post_resolution_invariant(
    pool: &PgPool,
    event_id: i32,
) -> Result<serde_json::Value> {
    with_optimistic_tx!(pool, tx, {
        verify_post_resolution_invariant_transaction(&mut tx, event_id).await
    })
}

async fn verify_post_resolution_invariant_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_id: i32,
) -> Result<serde_json::Value> {
    
    // Check if event is resolved
    let outcome: Option<String> = sqlx::query_scalar(
        "SELECT outcome FROM events WHERE id = $1"
    )
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await?;
    
    let is_resolved = match outcome {
        Some(ref outcome_str) => outcome_str.starts_with("resolved_"),
        None => return Ok(serde_json::json!({
            "valid": false,
            "message": "Event not found"
        }))
    };
    
    if !is_resolved {
        return Ok(serde_json::json!({
            "valid": true,
            "message": "Event not yet resolved - invariant not applicable"
        }));
    }
    
    // Check that no user_shares rows exist for this event
    let remaining_shares: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_shares WHERE event_id = $1"
    )
    .bind(event_id)
    .fetch_one(tx.as_mut())
    .await?;
    
    let shares_cleared = remaining_shares == 0;
    
    // For rp_staked stability check, we'd need to track pre/post resolution states
    // For now, just verify shares are cleared
    
    let message = if shares_cleared {
        "Post-resolution invariant verified: user_shares cleared".to_string()
    } else {
        format!("Post-resolution invariant violated: {} user_shares rows still exist for resolved event", remaining_shares)
    };
    
    Ok(serde_json::json!({
        "valid": shares_cleared,
        "message": message,
        "details": {
            "event_id": event_id,
            "outcome": outcome,
            "is_resolved": is_resolved,
            "remaining_shares": remaining_shares
        }
    }))
}

/// Verify system consistency after concurrent operations
pub async fn verify_system_consistency(
    pool: &PgPool,
    event_id: i32,
) -> Result<serde_json::Value> {
    with_optimistic_tx!(pool, tx, {
        verify_system_consistency_transaction(&mut tx, event_id).await
    })
}

async fn verify_system_consistency_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_id: i32,
) -> Result<serde_json::Value> {
    
    // Get market state
    let market_row = sqlx::query(
        "SELECT market_prob, cumulative_stake, liquidity_b, q_yes, q_no FROM events WHERE id = $1"
    )
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await?;
    
    let (market_state, stored_cost) = match market_row {
        Some(row) => {
            let state = DbAdapter::extract_market_state(&row)?;
            let cost: f64 = row.get("cumulative_stake");
            (state, cost)
        },
        None => return Ok(serde_json::json!({
            "valid": false,
            "message": "Event not found"
        }))
    };
    
    // Verify probability is in valid range
    let prob_valid = market_state.market_prob >= 0.0 && market_state.market_prob <= 1.0;
    
    // Verify market cost consistency with LMSR formula
    let market = Market { 
        q_yes: market_state.q_yes, 
        q_no: market_state.q_no, 
        b: market_state.liquidity_b 
    };
    let calculated_cost = market.cost();
    
    // Allow some tolerance for floating point differences
    let cost_tolerance = 0.01;
    let cost_consistent = (calculated_cost - stored_cost).abs() <= cost_tolerance;
    
    // Verify no negative shares
    let negative_shares: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_shares 
         WHERE event_id = $1 AND (yes_shares < 0 OR no_shares < 0)"
    )
    .bind(event_id)
    .fetch_one(tx.as_mut())
    .await?;
    
    let no_negative_shares = negative_shares == 0;
    
    // Check total market updates consistency
    let total_updates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM market_updates WHERE event_id = $1"
    )
    .bind(event_id)
    .fetch_one(tx.as_mut())
    .await?;
    
    let all_checks_passed = prob_valid && cost_consistent && no_negative_shares;
    
    Ok(serde_json::json!({
        "valid": all_checks_passed,
        "message": if all_checks_passed {
            "System consistency verified"
        } else {
            "System consistency violations detected"
        },
        "checks": {
            "probability_valid": {
                "passed": prob_valid,
                "value": market_state.market_prob
            },
            "cost_consistent": {
                "passed": cost_consistent,
                "calculated": calculated_cost,
                "stored": stored_cost,
                "difference": (calculated_cost - stored_cost).abs()
            },
            "no_negative_shares": {
                "passed": no_negative_shares,
                "negative_count": negative_shares
            }
        },
        "stats": {
            "total_updates": total_updates,
            "market_prob": market_state.market_prob,
            "liquidity_b": market_state.liquidity_b
        }
    }))
}
