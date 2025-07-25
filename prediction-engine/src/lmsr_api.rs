//! LMSR API layer using lmsr_core directly (DRY implementation)
//! Eliminates the redundant lmsr.rs wrapper for clean architecture

use crate::lmsr_core::{Market, to_ledger_units, from_ledger_units, Side};
use crate::db_adapter::DbAdapter;
use sqlx::{PgPool, Row, Executor};
use chrono::{DateTime, Utc, Duration};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::time::Duration as StdDuration;
use tokio::time::sleep;
use rand::Rng;

// Configuration constants for concurrency control
const MAX_RETRY_ATTEMPTS: u32 = 5;
const BASE_RETRY_DELAY_MS: u64 = 10;

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
                    
                    // Check if this is a serialization conflict that we should retry
                    let error_str = e.to_string().to_lowercase();
                    let is_retry_able = error_str.contains("serialization failure") ||
                                       error_str.contains("deadlock") ||
                                       error_str.contains("could not serialize");
                    
                    if is_retry_able && attempt < MAX_RETRY_ATTEMPTS {
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

/// Macro for executing transactions with REPEATABLE READ isolation (optimistic)
macro_rules! with_optimistic_tx {
    ($pool:expr, $tx_var:ident, $body:block) => {{
        let mut attempt = 1;
        loop {
            let mut $tx_var = $pool.begin().await?;
            
            // Set REPEATABLE READ isolation level
            $tx_var.execute(sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
                .await?;
            
            let result: Result<_> = async { $body }.await;
            
            match result {
                Ok(value) => {
                    $tx_var.commit().await?;
                    break Ok(value);
                }
                Err(e) => {
                    $tx_var.rollback().await.ok();
                    
                    // Check for version conflicts or concurrent updates
                    let error_str = e.to_string().to_lowercase();
                    let is_version_conflict = error_str.contains("version") ||
                                             error_str.contains("concurrent") ||
                                             error_str.contains("updated_at");
                    
                    if is_version_conflict && attempt < MAX_RETRY_ATTEMPTS {
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

    with_serializable_tx!(pool, tx, {
        update_market_transaction(&mut tx, user_id, &update).await
    })
}

// Internal transaction logic extracted for concurrency control
async fn update_market_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i32,
    update: &MarketUpdate,
) -> Result<UpdateResult> {
    
    // Get current market state with row lock
    let row = sqlx::query(
        "SELECT market_prob, cumulative_stake, liquidity_b, q_yes, q_no FROM events WHERE id = $1 FOR UPDATE"
    )
    .bind(update.event_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(|_| anyhow!("Event not found or market not initialized"))?;
    
    // Extract market state using clean adapter
    let market_state = DbAdapter::extract_market_state(&row)?;
    let prev_prob = market_state.market_prob;
    let liquidity_b = market_state.liquidity_b;
    let q_yes = market_state.q_yes;
    let q_no = market_state.q_no;
    
    // Create market from current state
    let mut market = Market { q_yes, q_no, b: liquidity_b };
    
    // Convert stake to ledger units for exact computation
    let stake_ledger = to_ledger_units(update.stake);
    
    // Execute trade based on target probability
    let (shares_acquired, side, actual_cost_ledger) = if update.target_prob > prev_prob {
        // Buy YES shares to increase probability
        let (shares, cost) = market.buy_yes(stake_ledger);
        (shares, Side::Yes, cost)
    } else {
        // Buy NO shares to decrease probability  
        let (shares, cost) = market.buy_no(stake_ledger);
        (shares, Side::No, cost)
    };
    
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
    
    // Deduct exact cost from user balance using clean adapter
    let has_sufficient_funds = DbAdapter::deduct_user_cost(tx, user_id, actual_cost).await?;
    if !has_sufficient_funds {
        return Err(anyhow!("Insufficient RP balance"));
    }
    
    // Record the update with 1-hour hold using clean adapter
    let hold_until = Utc::now() + Duration::hours(1);
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
    
    // Update user shares using clean adapter
    DbAdapter::update_user_shares(
        tx,
        user_id,
        update.event_id,
        side,
        shares_acquired,
        actual_cost,
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

    with_serializable_tx!(pool, tx, {
        sell_shares_transaction(&mut tx, user_id, event_id, side, amount).await
    })
}

// Internal transaction logic for sell_shares
async fn sell_shares_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i32,
    event_id: i32,
    side: Side,
    amount: f64,
) -> Result<SellResult> {
    
    // Check hold period
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
    
    // Get user shares
    let shares = sqlx::query_as::<_, (rust_decimal::Decimal, rust_decimal::Decimal)>(
        "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2"
    )
    .bind(user_id)
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await?;
    
    let (yes_shares_dec, no_shares_dec) = shares.unwrap_or((rust_decimal::Decimal::ZERO, rust_decimal::Decimal::ZERO));
    let yes_shares = DbAdapter::decimal_to_f64(yes_shares_dec)?;
    let no_shares = DbAdapter::decimal_to_f64(no_shares_dec)?;
    
    // Check sufficient shares
    match side {
        Side::Yes if yes_shares < amount => {
            return Err(anyhow!("Insufficient YES shares"));
        }
        Side::No if no_shares < amount => {
            return Err(anyhow!("Insufficient NO shares"));
        }
        _ => {} // Sufficient shares
    }
    
    // Get current market state
    let row = sqlx::query(
        "SELECT market_prob, cumulative_stake, liquidity_b, q_yes, q_no FROM events WHERE id = $1 FOR UPDATE"
    )
    .bind(event_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(|_| anyhow!("Event not found"))?;
    
    let market_state = DbAdapter::extract_market_state(&row)?;
    let liquidity_b = market_state.liquidity_b;
    let q_yes = market_state.q_yes;
    let q_no = market_state.q_no;
    
    // Create market and execute sell
    let mut market = Market { q_yes, q_no, b: liquidity_b };
    
    let payout_ledger = match side {
        Side::Yes => market.sell_yes(amount),
        Side::No => market.sell_no(amount),
    };
    
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
    
    // Calculate proportional stake to unwind
    let total_shares_of_type = match side {
        Side::Yes => yes_shares,
        Side::No => no_shares,
    };
    let stake_to_unwind = if total_shares_of_type > 0.0 {
        let total_user_stake: rust_decimal::Decimal = sqlx::query_scalar(
            "SELECT COALESCE(SUM(stake_amount), 0) FROM market_updates 
             WHERE user_id = $1 AND event_id = $2"
        )
        .bind(user_id)
        .bind(event_id)
        .fetch_one(tx.as_mut())
        .await?;
        
        let total_stake_f64 = DbAdapter::decimal_to_f64(total_user_stake)?;
        total_stake_f64 * (amount / total_shares_of_type)
    } else {
        0.0
    };
    
    // Update user balance using clean adapter
    DbAdapter::update_user_balance(
        tx,
        user_id,
        payout,
        -stake_to_unwind,
    ).await?;
    
    // Update user shares using clean adapter (subtract shares)
    DbAdapter::update_user_shares(
        tx,
        user_id,
        event_id,
        side,
        -amount, // Negative to subtract shares
        0.0,     // No cost for selling
    ).await?;
    
    Ok(SellResult {
        payout,
        new_prob,
        current_cost_c: new_cumulative_cost,
    })
}

// Kelly criterion suggestion
pub fn kelly_suggestion(
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
    
    // Conservative Kelly (25% of full Kelly for safety)
    let kelly_fraction = 0.25;
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
    
    // Get all user positions with aggregated stake data in single query
    let user_shares = sqlx::query(
        "SELECT user_id, yes_shares, no_shares, COALESCE(total_staked_ledger::NUMERIC / 1000000.0, 0) as total_staked
         FROM user_shares 
         WHERE event_id = $1 AND (yes_shares > 0 OR no_shares > 0)"
    )
    .bind(event_id)
    .fetch_all(tx.as_mut())
    .await?;
    
    // Calculate payout for each user
    for row in &user_shares {
        let user_id: i32 = row.get("user_id");
        let yes_shares: rust_decimal::Decimal = row.get("yes_shares");
        let no_shares: rust_decimal::Decimal = row.get("no_shares");
        let total_staked: rust_decimal::Decimal = row.get("total_staked");
        
        let yes_shares_f64 = DbAdapter::decimal_to_f64(yes_shares)?;
        let no_shares_f64 = DbAdapter::decimal_to_f64(no_shares)?;
        let total_staked_f64 = DbAdapter::decimal_to_f64(total_staked)?;
        
        // Calculate final share value based on outcome
        let share_value_f64 = if outcome {
            yes_shares_f64  // YES outcome: YES shares worth 1, NO shares worth 0
        } else {
            no_shares_f64   // NO outcome: NO shares worth 1, YES shares worth 0
        };
        
        // Update user balance with share value and clear staked amount using clean adapter
        DbAdapter::update_user_balance(
            tx,
            user_id,
            share_value_f64,
            -total_staked_f64,
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
            let market_prob = DbAdapter::decimal_to_f64(row.get("market_prob"))?;
            let cumulative_stake = DbAdapter::decimal_to_f64(row.get("cumulative_stake"))?;
            let liquidity_b = DbAdapter::decimal_to_f64(row.get("liquidity_b"))?;
            
            Ok(serde_json::json!({
                "event_id": row.get::<i32, _>("id"),
                "title": row.get::<String, _>("title"),
                "market_prob": market_prob,
                "cumulative_stake": cumulative_stake,
                "liquidity_b": liquidity_b,
                "unique_traders": row.get::<i64, _>("unique_traders"),
                "total_trades": row.get::<i64, _>("total_trades"),
            }))
        }
        None => Err(anyhow!("Event not found")),
    }
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
            let yes_shares = DbAdapter::decimal_to_f64(row.get("yes_shares"))?;
            let no_shares = DbAdapter::decimal_to_f64(row.get("no_shares"))?;
            
            Ok(serde_json::json!({
                "yes_shares": yes_shares,
                "no_shares": no_shares,
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