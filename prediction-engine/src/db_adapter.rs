//! Database adapter layer for clean numeric conversions
//! Eliminates scattered to_f64()/from_f64() calls throughout the codebase

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use anyhow::{Result, anyhow};
use sqlx::Row;
use chrono::{DateTime, Utc};
use crate::lmsr_core::Side;

/// Clean conversion functions between database Decimal and core f64 math
pub struct DbAdapter;

impl DbAdapter {
    /// Convert database Decimal to f64 for LMSR math
    #[inline]
    pub fn decimal_to_f64(decimal: Decimal) -> Result<f64> {
        decimal.to_f64()
            .ok_or_else(|| anyhow!("Failed to convert Decimal to f64: {}", decimal))
    }
    
    /// Convert f64 result back to Decimal for database storage
    #[inline]
    pub fn f64_to_decimal(value: f64) -> Result<Decimal> {
        if !value.is_finite() {
            return Err(anyhow!("Cannot convert non-finite f64 to Decimal: {}", value));
        }
        Decimal::from_f64_retain(value)
            .ok_or_else(|| anyhow!("Failed to convert f64 to Decimal: {}", value))
    }
    
    /// Extract market state from database row as f64 values
    pub fn extract_market_state(row: &sqlx::postgres::PgRow) -> Result<MarketState> {
        Ok(MarketState {
            market_prob: Self::decimal_to_f64(row.get("market_prob"))?,
            liquidity_b: Self::decimal_to_f64(row.get("liquidity_b"))?,
            q_yes: Self::decimal_to_f64(row.get("q_yes"))?,
            q_no: Self::decimal_to_f64(row.get("q_no"))?,
        })
    }
    
    /// Extract user shares from database row as f64 values
    pub fn extract_user_shares(row: &sqlx::postgres::PgRow) -> Result<UserShares> {
        Ok(UserShares {
            yes_shares: Self::decimal_to_f64(row.get("yes_shares"))?,
            no_shares: Self::decimal_to_f64(row.get("no_shares"))?,
            total_staked: Self::decimal_to_f64(row.get("total_staked"))?,
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

/// Clean user shares structure for f64 math
#[derive(Debug)]
pub struct UserShares {
    pub yes_shares: f64,
    pub no_shares: f64, 
    pub total_staked: f64,
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
             WHERE id = $5"
        )
        .bind(Self::f64_to_decimal(new_prob)?)
        .bind(Self::f64_to_decimal(new_cost)?)
        .bind(Self::f64_to_decimal(q_yes)?)
        .bind(Self::f64_to_decimal(q_no)?)
        .bind(event_id)
        .execute(&mut **tx)
        .await?;
        
        Ok(())
    }
    
    /// Update user balance from f64 values
    pub async fn update_user_balance(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        balance_delta: f64,
        staked_delta: f64,
    ) -> Result<u64> {
        let rows_affected = sqlx::query(
            "UPDATE users SET 
                rp_balance = rp_balance + $1,
                rp_staked = rp_staked + $2
             WHERE id = $3 AND (rp_balance + $1) >= 0"
        )
        .bind(Self::f64_to_decimal(balance_delta)?)
        .bind(Self::f64_to_decimal(staked_delta)?)
        .bind(user_id)
        .execute(&mut **tx)
        .await?
        .rows_affected();
        
        Ok(rows_affected)
    }
    
    /// Deduct cost from user balance with sufficient funds check
    pub async fn deduct_user_cost(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        cost: f64,
    ) -> Result<bool> {
        let rows_affected = sqlx::query(
            "UPDATE users SET 
                rp_balance = rp_balance - $1,
                rp_staked = rp_staked + $1
             WHERE id = $2 AND rp_balance >= $1"
        )
        .bind(Self::f64_to_decimal(cost)?)
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
    ) -> Result<()> {
        let share_type = side.as_str();
        sqlx::query(
            "INSERT INTO market_updates 
             (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
        )
        .bind(user_id)
        .bind(event_id)
        .bind(Self::f64_to_decimal(prev_prob)?)
        .bind(Self::f64_to_decimal(new_prob)?)
        .bind(Self::f64_to_decimal(cost)?)
        .bind(Self::f64_to_decimal(shares)?)
        .bind(share_type)
        .bind(hold_until)
        .execute(&mut **tx)
        .await?;
        
        Ok(())
    }
    
    /// Update user shares with f64 values
    pub async fn update_user_shares(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        user_id: i32,
        event_id: i32,
        side: Side,
        shares_delta: f64,
        cost: f64,
    ) -> Result<()> {
        let cost_ledger = crate::lmsr_core::to_ledger_units(cost)
            .map_err(|e| anyhow!("Invalid cost value: {}", e))? as i64;
        
        match side {
            Side::Yes => {
                sqlx::query(
                    "INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares, total_staked_ledger, version)
                     VALUES ($1, $2, $3, 0, $4, 1)
                     ON CONFLICT (user_id, event_id)
                     DO UPDATE SET 
                        yes_shares = user_shares.yes_shares + $3,
                        total_staked_ledger = user_shares.total_staked_ledger + $4,
                        version = user_shares.version + 1,
                        last_updated = NOW()"
                )
                .bind(user_id)
                .bind(event_id)
                .bind(Self::f64_to_decimal(shares_delta)?)
                .bind(cost_ledger)
                .execute(&mut **tx)
                .await?;
            }
            Side::No => {
                sqlx::query(
                    "INSERT INTO user_shares (user_id, event_id, yes_shares, no_shares, total_staked_ledger, version)
                     VALUES ($1, $2, 0, $3, $4, 1)
                     ON CONFLICT (user_id, event_id)
                     DO UPDATE SET 
                        no_shares = user_shares.no_shares + $3,
                        total_staked_ledger = user_shares.total_staked_ledger + $4,
                        version = user_shares.version + 1,
                        last_updated = NOW()"
                )
                .bind(user_id)
                .bind(event_id)
                .bind(Self::f64_to_decimal(shares_delta)?)
                .bind(cost_ledger)
                .execute(&mut **tx)
                .await?;
            }
        }
        
        Ok(())
    }
}