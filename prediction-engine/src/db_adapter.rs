//! Database adapter layer for clean numeric conversions
//! Eliminates scattered to_f64()/from_f64() calls throughout the codebase

use crate::lmsr_core::Side;
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use sqlx::Row;
use tracing::debug;

/// Clean conversion helpers between database rows and core f64 math
pub struct DbAdapter;

impl DbAdapter {
    /// Extract market state from database row as f64 values
    pub fn extract_market_state(row: &sqlx::postgres::PgRow) -> Result<MarketState> {
        Ok(MarketState {
            market_prob: row.get("market_prob"),
            liquidity_b: row.get("liquidity_b"),
            q_yes: row.get("q_yes"),
            q_no: row.get("q_no"),
        })
    }
}

/// Clean market state structure for f64 math
#[derive(Debug)]
pub struct MarketState {
    pub market_prob: f64,
    pub liquidity_b: f64,
    pub q_yes: f64,
    pub q_no: f64,
}

/// Database update operations with clean conversions
impl DbAdapter {
    /// Update market state in database from f64 values
    pub async fn update_market_state(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        event_id: i32,
        new_prob: f64,
        new_cost: f64,
        q_yes: f64,
        q_no: f64,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE events SET 
                market_prob = $1,
                cumulative_stake = $2,
                q_yes = $3,
                q_no = $4
             WHERE id = $5",
        )
        .bind(new_prob)
        .bind(new_cost)
        .bind(q_yes)
        .bind(q_no)
        .bind(event_id)
        .execute(&mut **tx)
        .await?;

        Ok(())
    }

    /// Update user balance from ledger units (bypasses f64 conversion for single rounding boundary)
    pub async fn update_user_balance_ledger(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        balance_delta_ledger: i64,
        staked_delta_ledger: i64,
    ) -> Result<u64> {
        let rows_affected = sqlx::query(
            "UPDATE users SET
                rp_balance_ledger = rp_balance_ledger + $1,
                rp_staked_ledger  = rp_staked_ledger  + $2
             WHERE id = $3
               AND (rp_balance_ledger + $1) >= 0
               AND (rp_staked_ledger  + $2) >= 0",
        )
        .bind(balance_delta_ledger)
        .bind(staked_delta_ledger)
        .bind(user_id)
        .execute(&mut **tx)
        .await?
        .rows_affected();

        Ok(rows_affected)
    }

    /// Deduct cost from user balance using ledger units (bypasses f64 conversion)
    pub async fn deduct_user_cost_ledger(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        cost_ledger: i64,
    ) -> Result<bool> {
        let rows_affected = sqlx::query(
            "UPDATE users SET 
                rp_balance_ledger = rp_balance_ledger - $1,
                rp_staked_ledger  = rp_staked_ledger  + $1
             WHERE id = $2
               AND (rp_balance_ledger - $1) >= 0
               AND (rp_staked_ledger  + $1) >= 0",
        )
        .bind(cost_ledger)
        .bind(user_id)
        .execute(&mut **tx)
        .await?
        .rows_affected();

        Ok(rows_affected > 0)
    }

    /// Record market update with f64 values
    pub async fn record_market_update(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        event_id: i32,
        prev_prob: f64,
        new_prob: f64,
        cost: f64,
        shares: f64,
        side: Side,
        hold_until: DateTime<Utc>,
        referral_post_id: Option<i32>,
        referral_click_id: Option<i32>,
        had_prior_position: bool,
    ) -> Result<i32> {
        let share_type = side.as_str();
        let cost_ledger = i64::try_from(
            crate::lmsr_core::to_ledger_units(cost)
                .map_err(|e| anyhow!("Invalid cost value: {}", e))?,
        )
        .map_err(|_| anyhow!("stake_amount_ledger out of i64 range"))?;

        let row = sqlx::query(
            "INSERT INTO market_updates 
             (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until, stake_amount_ledger, referral_post_id, referral_click_id, had_prior_position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING id"
        )
        .bind(user_id)
        .bind(event_id)
        .bind(prev_prob)
        .bind(new_prob)
        .bind(cost)
        .bind(shares)
        .bind(share_type)
        .bind(hold_until)
        .bind(cost_ledger)
        .bind(referral_post_id)
        .bind(referral_click_id)
        .bind(had_prior_position)
        .fetch_one(&mut **tx)
        .await?;

        let market_update_id: i32 = row.get("id");
        Ok(market_update_id)
    }

    /// Update user shares with ledger-native cost (bypasses f64 conversion for single rounding boundary)
    pub async fn update_user_shares_ledger(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        event_id: i32,
        side: Side,
        shares_delta: f64,
        cost_ledger: i64,
    ) -> Result<()> {
        match side {
            Side::Yes => {
                debug!(
                    user_id,
                    event_id, shares_delta, cost_ledger, "update_user_shares_ledger YES side"
                );
                sqlx::query(
                    "INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares, total_staked_ledger, staked_yes_ledger, staked_no_ledger, version)
                     VALUES ($1, $2, $3, 0, $4, $4, 0, 1)
                     ON CONFLICT (user_id, event_id)
                     DO UPDATE SET 
                        yes_shares = user_shares.yes_shares + $3,
                        staked_yes_ledger = user_shares.staked_yes_ledger + $4,
                        total_staked_ledger = user_shares.total_staked_ledger + $4,
                        version = user_shares.version + 1,
                        last_updated = NOW()"
                )
                .bind(user_id)
                .bind(event_id)
                .bind(shares_delta)
                .bind(cost_ledger)
                .execute(&mut **tx)
                .await?;
            }
            Side::No => {
                sqlx::query(
                    "INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares, total_staked_ledger, staked_yes_ledger, staked_no_ledger, version)
                     VALUES ($1, $2, 0, $3, $4, 0, $4, 1)
                     ON CONFLICT (user_id, event_id)
                     DO UPDATE SET 
                        no_shares = user_shares.no_shares + $3,
                        staked_no_ledger = user_shares.staked_no_ledger + $4,
                        total_staked_ledger = user_shares.total_staked_ledger + $4,
                        version = user_shares.version + 1,
                        last_updated = NOW()"
                )
                .bind(user_id)
                .bind(event_id)
                .bind(shares_delta)
                .bind(cost_ledger)
                .execute(&mut **tx)
                .await?;
            }
        }

        Ok(())
    }

    /// Update user shares with side-specific stake unwinding for sell operations
    pub async fn update_user_shares_with_side_unwind_ledger(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        event_id: i32,
        side: Side,
        shares_delta: f64,        // Negative for selling
        stake_unwind_ledger: i64, // Positive amount to unwind from side-specific stake
    ) -> Result<()> {
        match side {
            Side::Yes => {
                sqlx::query(
                    "UPDATE user_shares SET 
                        yes_shares = yes_shares + $3,
                        total_staked_ledger = total_staked_ledger - $4,
                        staked_yes_ledger = staked_yes_ledger - $4,
                        version = version + 1,
                        last_updated = NOW()
                     WHERE user_id = $1 AND event_id = $2",
                )
                .bind(user_id)
                .bind(event_id)
                .bind(shares_delta)
                .bind(stake_unwind_ledger)
                .execute(&mut **tx)
                .await?;
            }
            Side::No => {
                sqlx::query(
                    "UPDATE user_shares SET 
                        no_shares = no_shares + $3,
                        total_staked_ledger = total_staked_ledger - $4,
                        staked_no_ledger = staked_no_ledger - $4,
                        version = version + 1,
                        last_updated = NOW()
                     WHERE user_id = $1 AND event_id = $2",
                )
                .bind(user_id)
                .bind(event_id)
                .bind(shares_delta)
                .bind(stake_unwind_ledger)
                .execute(&mut **tx)
                .await?;
            }
        }

        Ok(())
    }
}
