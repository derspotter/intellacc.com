// Core LMSR (Logarithmic Market Scoring Rule) implementation
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use sqlx::{PgPool, postgres::PgRow, Row};
use chrono::{DateTime, Utc, Duration};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct MarketUpdate {
    pub event_id: i32,
    pub target_prob: Decimal,  // User's belief (0-1)
    pub stake: Decimal,        // Amount of RP to stake
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateResult {
    pub prev_prob: Decimal,
    pub new_prob: Decimal,
    pub shares_acquired: Decimal,
    pub share_type: String,
    pub hold_until: DateTime<Utc>,
    pub expected_payout_if_yes: Decimal,
    pub expected_payout_if_no: Decimal,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KellySuggestion {
    pub kelly_suggestion: Decimal,
    pub quarter_kelly: Decimal,
    pub current_prob: Decimal,
    pub balance: Decimal,
}

#[derive(Debug)]
struct EventMarketState {
    market_prob: Decimal,
    cumulative_stake: Decimal,
    liquidity_b: Decimal,
}

// Core LMSR update function using stake-weighted average
pub async fn update_market(
    pool: &PgPool,
    user_id: i32,
    update: MarketUpdate,
) -> Result<UpdateResult> {
    let mut tx = pool.begin().await?;
    
    // Get current market state
    let event: EventMarketState = sqlx::query_as::<_, (Decimal, Decimal, Decimal)>(
        "SELECT market_prob, cumulative_stake, liquidity_b FROM events WHERE id = $1"
    )
    .bind(update.event_id)
    .fetch_one(&mut *tx)
    .await
    .map(|(prob, stake, b)| EventMarketState {
        market_prob: prob,
        cumulative_stake: stake,
        liquidity_b: b,
    })
    .map_err(|_| anyhow!("Event not found or market not initialized"))?;
    
    let r_t = event.market_prob;
    let s_t_cumulative = event.cumulative_stake;
    
    // Validate probability is in valid range
    if update.target_prob <= Decimal::ZERO || update.target_prob >= Decimal::ONE {
        return Err(anyhow!("Target probability must be between 0 and 1"));
    }
    
    // Calculate new probability using stake-weighted average
    // r_{t+1} = (s_t * target_prob + S_t * r_t) / (s_t + S_t)
    let stake = update.stake;
    let target = update.target_prob;
    let new_prob = (stake * target + s_t_cumulative * r_t) / (stake + s_t_cumulative);
    
    // Calculate shares based on direction
    let (shares, share_type) = if target > r_t {
        // Buying YES (raising probability)
        let shares = stake / r_t;
        (shares, "yes".to_string())
    } else {
        // Buying NO (lowering probability)
        let shares = stake / (Decimal::ONE - r_t);
        (shares, "no".to_string())
    };
    
    // Update market state
    sqlx::query(
        "UPDATE events SET 
            market_prob = $1,
            cumulative_stake = cumulative_stake + $2
         WHERE id = $3"
    )
    .bind(new_prob)
    .bind(stake)
    .bind(update.event_id)
    .execute(&mut *tx)
    .await?;
    
    // Deduct stake from user balance and add to staked
    let rows_affected = sqlx::query(
        "UPDATE users SET 
            rp_balance = rp_balance - $1,
            rp_staked = rp_staked + $1
         WHERE id = $2 AND rp_balance >= $1"
    )
    .bind(stake)
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    
    if rows_affected == 0 {
        return Err(anyhow!("Insufficient RP balance"));
    }
    
    // Record the update with 1-hour hold
    let hold_until = Utc::now() + Duration::hours(1);
    sqlx::query(
        "INSERT INTO market_updates 
         (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
    )
    .bind(user_id)
    .bind(update.event_id)
    .bind(r_t)
    .bind(new_prob)
    .bind(stake)
    .bind(shares)
    .bind(&share_type)
    .bind(hold_until)
    .execute(&mut *tx)
    .await?;
    
    // Update user shares
    if share_type == "yes" {
        sqlx::query(
            "INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (user_id, event_id)
             DO UPDATE SET yes_shares = user_shares.yes_shares + $3"
        )
        .bind(user_id)
        .bind(update.event_id)
        .bind(shares)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares)
             VALUES ($1, $2, 0, $3)
             ON CONFLICT (user_id, event_id)
             DO UPDATE SET no_shares = user_shares.no_shares + $3"
        )
        .bind(user_id)
        .bind(update.event_id)
        .bind(shares)
        .execute(&mut *tx)
        .await?;
    }
    
    tx.commit().await?;
    
    // Calculate expected payouts for display
    let expected_if_yes = if share_type == "yes" { 
        shares 
    } else { 
        Decimal::ZERO 
    };
    let expected_if_no = if share_type == "no" { 
        shares 
    } else { 
        Decimal::ZERO 
    };
    
    Ok(UpdateResult {
        prev_prob: r_t,
        new_prob,
        shares_acquired: shares,
        share_type,
        hold_until,
        expected_payout_if_yes: expected_if_yes,
        expected_payout_if_no: expected_if_no,
    })
}

// Sell shares back to market (after hold period)
pub async fn sell_shares(
    pool: &PgPool,
    user_id: i32,
    event_id: i32,
    share_type: &str,
    amount: Decimal,
) -> Result<Decimal> {
    let mut tx = pool.begin().await?;
    
    // Validate share type
    if share_type != "yes" && share_type != "no" {
        return Err(anyhow!("Invalid share type"));
    }
    
    // Check if user has enough shares
    let shares = sqlx::query_as::<_, (Decimal, Decimal)>(
        "SELECT yes_shares, no_shares FROM user_shares WHERE user_id = $1 AND event_id = $2"
    )
    .bind(user_id)
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    
    let (yes_shares, no_shares) = shares.unwrap_or((Decimal::ZERO, Decimal::ZERO));
    
    if share_type == "yes" && yes_shares < amount {
        return Err(anyhow!("Insufficient YES shares"));
    }
    if share_type == "no" && no_shares < amount {
        return Err(anyhow!("Insufficient NO shares"));
    }
    
    // Get current market price
    let market_prob: Decimal = sqlx::query_scalar(
        "SELECT market_prob FROM events WHERE id = $1"
    )
    .bind(event_id)
    .fetch_one(&mut *tx)
    .await?;
    
    // Calculate payout
    let payout = if share_type == "yes" {
        amount * market_prob
    } else {
        amount * (Decimal::ONE - market_prob)
    };
    
    // Update user balance and shares
    sqlx::query(
        "UPDATE users SET 
            rp_balance = rp_balance + $1,
            rp_staked = GREATEST(0, rp_staked - $1)
         WHERE id = $2"
    )
    .bind(payout)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    
    if share_type == "yes" {
        sqlx::query(
            "UPDATE user_shares SET yes_shares = yes_shares - $1
             WHERE user_id = $2 AND event_id = $3"
        )
        .bind(amount)
        .bind(user_id)
        .bind(event_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "UPDATE user_shares SET no_shares = no_shares - $1
             WHERE user_id = $2 AND event_id = $3"
        )
        .bind(amount)
        .bind(user_id)
        .bind(event_id)
        .execute(&mut *tx)
        .await?;
    }
    
    tx.commit().await?;
    Ok(payout)
}

// Kelly criterion suggestion
pub fn kelly_suggestion(
    belief: Decimal,
    market_prob: Decimal,
    balance: Decimal,
) -> KellySuggestion {
    // Calculate edge
    let edge = if belief > market_prob {
        (belief - market_prob) / (Decimal::ONE - market_prob)
    } else {
        (market_prob - belief) / market_prob
    };
    
    // Conservative Kelly (25% of full Kelly for safety)
    let kelly_fraction = Decimal::from_str("0.25").unwrap();
    let suggestion = (edge * balance * kelly_fraction)
        .max(Decimal::ZERO)
        .min(balance * kelly_fraction);
    
    KellySuggestion {
        kelly_suggestion: suggestion,
        quarter_kelly: suggestion / Decimal::from(4),
        current_prob: market_prob,
        balance,
    }
}

// Calculate P/L at resolution
pub async fn resolve_event(
    pool: &PgPool,
    event_id: i32,
    outcome: bool,  // true = YES, false = NO
) -> Result<()> {
    let mut tx = pool.begin().await?;
    
    // Get all updates for this event
    let updates = sqlx::query(
        "SELECT user_id, prev_prob, new_prob, stake_amount
         FROM market_updates
         WHERE event_id = $1"
    )
    .bind(event_id)
    .fetch_all(&mut *tx)
    .await?;
    
    // Get b parameter
    let b: Decimal = sqlx::query_scalar(
        "SELECT liquidity_b FROM events WHERE id = $1"
    )
    .bind(event_id)
    .fetch_one(&mut *tx)
    .await?;
    
    // Calculate P/L for each update
    let mut total_pl = Decimal::ZERO;
    let mut payouts = Vec::new();
    
    for row in &updates {
        let user_id: i32 = row.get(0);
        let prev_prob: Decimal = row.get(1);
        let new_prob: Decimal = row.get(2);
        let stake: Decimal = row.get(3);
        
        // LMSR P/L formula
        let log_score = if outcome {
            // YES outcome: b * log(new_prob/prev_prob)
            b * (new_prob / prev_prob).ln()
        } else {
            // NO outcome: b * log((1-new_prob)/(1-prev_prob))
            b * ((Decimal::ONE - new_prob) / (Decimal::ONE - prev_prob)).ln()
        };
        
        // P/L = stake * exp(log_score / stake) - stake
        let exp_arg = log_score / stake;
        let exp_value = exp_arg.to_f64()
            .and_then(|x| x.exp().to_string().parse::<Decimal>().ok())
            .unwrap_or(Decimal::ONE);
        
        let pl = stake * exp_value - stake;
        total_pl += pl;
        payouts.push((user_id, pl, stake));
    }
    
    // Apply zero-sum offset
    let num_payouts = Decimal::from(payouts.len());
    let offset = if num_payouts > Decimal::ZERO {
        total_pl / num_payouts
    } else {
        Decimal::ZERO
    };
    
    for (user_id, pl, stake) in payouts {
        let adjusted_pl = pl - offset;
        let final_payout = stake + adjusted_pl;  // Return stake + profit/loss
        
        sqlx::query(
            "UPDATE users SET 
                rp_balance = rp_balance + $1,
                rp_staked = GREATEST(0, rp_staked - $2)
             WHERE id = $3"
        )
        .bind(final_payout)
        .bind(stake)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    }
    
    // Mark event as resolved
    let outcome_str = if outcome { "resolved_yes" } else { "resolved_no" };
    sqlx::query(
        "UPDATE events SET outcome = $1 WHERE id = $2"
    )
    .bind(outcome_str)
    .bind(event_id)
    .execute(&mut *tx)
    .await?;
    
    // Clear user shares for this event
    sqlx::query(
        "DELETE FROM user_shares WHERE event_id = $1"
    )
    .bind(event_id)
    .execute(&mut *tx)
    .await?;
    
    tx.commit().await?;
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
                "event_id": row.get::<i32, _>(0),
                "title": row.get::<String, _>(1),
                "market_prob": row.get::<Decimal, _>(2),
                "cumulative_stake": row.get::<Decimal, _>(3),
                "liquidity_b": row.get::<Decimal, _>(4),
                "unique_traders": row.get::<i64, _>(5),
                "total_trades": row.get::<i64, _>(6),
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
            Ok(serde_json::json!({
                "yes_shares": row.get::<Decimal, _>(0),
                "no_shares": row.get::<Decimal, _>(1),
            }))
        }
        None => {
            Ok(serde_json::json!({
                "yes_shares": 0,
                "no_shares": 0,
            }))
        }
    }
}