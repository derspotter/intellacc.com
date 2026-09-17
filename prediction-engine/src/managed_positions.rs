//! Durable, scheduled binary positions. All trades in one adjustment commit together.
use crate::{
    config::Config,
    lmsr_api,
    lmsr_core::{from_ledger_units, Market, Side},
};
use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};

const MIN_TRADE_RP: f64 = 0.01;
const MAX_SHARES: f64 = 10_000_000.0;
pub const MANUAL_BLOCKED: &str = "Pause automatic management before trading manually";

pub fn interval_seconds() -> u64 {
    std::env::var("MANAGED_POSITION_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (3600..=604800).contains(value))
        .unwrap_or(86400)
}

// Match the backend's requirePhoneVerified configuration, including its default.
fn phone_verification_required() -> bool {
    let value = std::env::var("PHONE_VERIFICATION_ENABLED").unwrap_or_default();
    match value.trim().to_lowercase().as_str() {
        "" | "true" | "1" | "yes" => true,
        _ => false,
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Policy {
    pub enabled: bool,
    pub belief_prob: Option<f64>,
    pub kelly_fraction: Option<f64>,
    pub status: String,
    pub last_error: Option<String>,
    pub last_trade_summary: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_rebalanced_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct Settings {
    pub user_id: i32,
    pub enabled: bool,
    pub belief_prob: Option<f64>,
    pub kelly_fraction: Option<f64>,
}

fn validate(belief: f64, fraction: f64) -> Result<()> {
    if !belief.is_finite() || belief <= 0.0 || belief >= 1.0 {
        bail!("Probability must be between 0 and 1, exclusive");
    }
    if ![0.25, 0.5, 1.0].contains(&fraction) {
        bail!("Choose quarter, half, or full Kelly");
    }
    Ok(())
}

pub async fn get(pool: &PgPool, user_id: i32, event_id: i32) -> Result<Policy> {
    let policy = sqlx::query_as::<_, Policy>(
        "SELECT enabled, belief_prob, kelly_fraction, status, last_error, last_trade_summary,
         last_checked_at, last_rebalanced_at FROM managed_positions WHERE user_id=$1 AND event_id=$2"
    ).bind(user_id).bind(event_id).fetch_optional(pool).await?;
    Ok(policy.unwrap_or(Policy {
        enabled: false,
        belief_prob: None,
        kelly_fraction: None,
        status: "paused".into(),
        last_error: None,
        last_trade_summary: None,
        last_checked_at: None,
        last_rebalanced_at: None,
    }))
}

pub async fn save(pool: &PgPool, event_id: i32, settings: Settings) -> Result<Policy> {
    if event_id <= 0 || settings.user_id <= 0 {
        bail!("Invalid event or user id");
    }
    if settings.enabled {
        validate(
            settings
                .belief_prob
                .ok_or_else(|| anyhow!("Probability required"))?,
            settings
                .kelly_fraction
                .ok_or_else(|| anyhow!("Kelly fraction required"))?,
        )?;
    }
    let mut tx = pool.begin().await?;
    // Same order as every trade: event first. Pausing waits for any in-flight
    // adjustment, and no later adjustment can pass its enabled check.
    let event = sqlx::query(
        "SELECT event_type, outcome, COALESCE(closing_date<=NOW(),false) AS closed
        FROM events WHERE id=$1 FOR UPDATE",
    )
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("Event not found"))?;
    if settings.enabled {
        if event.get::<String, _>("event_type") != "binary" {
            bail!("Management supports binary markets only");
        }
        if event.get::<Option<String>, _>("outcome").is_some() || event.get::<bool, _>("closed") {
            bail!("Market is closed or resolved");
        }
        let tier: Option<i32> =
            sqlx::query_scalar("SELECT COALESCE(verification_tier,0) FROM users WHERE id=$1")
                .bind(settings.user_id)
                .fetch_optional(&mut *tx)
                .await?;
        if phone_verification_required() && tier.unwrap_or(0) < 2 {
            bail!("Phone verification required for automatic management");
        }
        sqlx::query("INSERT INTO managed_positions (user_id,event_id,enabled,belief_prob,kelly_fraction,status)
            VALUES ($1,$2,true,$3,$4,'scheduled') ON CONFLICT (user_id,event_id) DO UPDATE SET
            enabled=true,belief_prob=$3,kelly_fraction=$4,status='scheduled',last_error=NULL,updated_at=NOW()")
            .bind(settings.user_id).bind(event_id).bind(settings.belief_prob).bind(settings.kelly_fraction)
            .execute(&mut *tx).await?;
    } else {
        sqlx::query("UPDATE managed_positions SET enabled=false,status='paused',last_error=NULL,updated_at=NOW()
            WHERE user_id=$1 AND event_id=$2")
            .bind(settings.user_id).bind(event_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    get(pool, settings.user_id, event_id).await
}

/// Called ONLY by manual entry points, inside their transaction. Reusing the
/// internal trade functions below lets the manager retain the same ledger rules.
pub async fn ensure_manual(
    tx: &mut Transaction<'_, Postgres>,
    user: i32,
    event: i32,
) -> Result<()> {
    sqlx::query("SELECT id FROM events WHERE id=$1 FOR UPDATE")
        .bind(event)
        .execute(&mut **tx)
        .await?;
    // Keep legacy installations/tests usable before the additive migration.
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('managed_positions') IS NOT NULL")
        .fetch_one(&mut **tx)
        .await?;
    if exists {
        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM managed_positions WHERE user_id=$1 AND event_id=$2 AND enabled)")
            .bind(user).bind(event).fetch_one(&mut **tx).await?;
        if active {
            bail!(MANUAL_BLOCKED);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct Target {
    pub yes: f64,
    pub no: f64,
}

/// Full Kelly maximizes expected log terminal wealth, including LMSR price
/// impact. Fractional Kelly scales that target share exposure. Remove the
/// user's existing holdings first: otherwise their own last fill feeds back
/// into the next sizing calculation and creates needless oscillation.
pub fn target(
    market: Market,
    cash: f64,
    yes: f64,
    no: f64,
    belief: f64,
    fraction: f64,
) -> Result<Target> {
    validate(belief, fraction)?;
    if ![market.q_yes, market.q_no, market.b, cash, yes, no]
        .iter()
        .all(|v| v.is_finite())
        || market.b <= 0.0
        || cash < 0.0
        || yes < 0.0
        || no < 0.0
    {
        bail!("Invalid market or position state");
    }
    let external = Market {
        q_yes: market.q_yes - yes,
        q_no: market.q_no - no,
        b: market.b,
    };
    let base_cost = external.cost();
    let wealth = cash + market.cost() - base_cost;
    let price = external.prob_yes();
    if !wealth.is_finite() || !price.is_finite() {
        bail!("Invalid market wealth");
    }
    if wealth < MIN_TRADE_RP || (belief - price).abs() < 1e-10 {
        return Ok(Target { yes: 0.0, no: 0.0 });
    }
    let side = if belief > price { Side::Yes } else { Side::No };
    let p = if side == Side::Yes {
        belief
    } else {
        1.0 - belief
    };
    let derivative = |shares: f64| {
        let mut after = external;
        if side == Side::Yes {
            after.q_yes += shares;
        } else {
            after.q_no += shares;
        }
        let remaining = wealth - (after.cost() - base_cost);
        if remaining <= 0.000001 {
            return f64::NEG_INFINITY;
        }
        let marginal = if side == Side::Yes {
            after.prob_yes()
        } else {
            1.0 - after.prob_yes()
        };
        p * (1.0 - marginal) / (remaining + shares) - (1.0 - p) * marginal / remaining
    };
    let mut low = 0.0;
    let mut high = MAX_SHARES;
    for _ in 0..90 {
        let mid = (low + high) * 0.5;
        if derivative(mid) > 0.0 {
            low = mid;
        } else {
            high = mid;
        }
    }
    let shares = fraction * low;
    Ok(if side == Side::Yes {
        Target {
            yes: shares,
            no: 0.0,
        }
    } else {
        Target {
            yes: 0.0,
            no: shares,
        }
    })
}

#[derive(Serialize)]
pub struct Adjustment {
    pub event_id: i32,
    pub user_id: i32,
    pub new_prob: f64,
}

pub async fn rebalance(
    pool: &PgPool,
    config: &Config,
    user: i32,
    event: i32,
    interval: u64,
) -> Result<Option<Adjustment>> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query("SELECT q_yes,q_no,liquidity_b,event_type,outcome,COALESCE(closing_date<=NOW(),false) AS closed
        FROM events WHERE id=$1 FOR UPDATE").bind(event).fetch_one(&mut *tx).await?;
    let policy = sqlx::query("SELECT belief_prob,kelly_fraction FROM managed_positions
        WHERE user_id=$1 AND event_id=$2 AND enabled
        AND ($3=0 OR (updated_at<to_timestamp(floor(extract(epoch from NOW())/GREATEST($3,1))*GREATEST($3,1))
        AND (last_checked_at IS NULL OR last_checked_at<to_timestamp(floor(extract(epoch from NOW())/GREATEST($3,1))*GREATEST($3,1))))) FOR UPDATE")
        .bind(user).bind(event).bind(interval as f64).fetch_optional(&mut *tx).await?;
    let Some(policy) = policy else {
        return Ok(None);
    };
    let holdings = sqlx::query(
        "SELECT yes_shares,no_shares FROM user_shares WHERE user_id=$1 AND event_id=$2 FOR UPDATE",
    )
    .bind(user)
    .bind(event)
    .fetch_optional(&mut *tx)
    .await?;
    let account = sqlx::query("SELECT rp_balance_ledger,COALESCE(verification_tier,0) AS tier FROM users WHERE id=$1 FOR UPDATE")
        .bind(user).fetch_one(&mut *tx).await?;
    let stop = if row.get::<Option<String>, _>("outcome").is_some() || row.get::<bool, _>("closed")
    {
        Some("Market is closed or resolved. Management stopped.")
    } else if row.get::<String, _>("event_type") != "binary" {
        Some("Management supports binary markets only.")
    } else if phone_verification_required() && account.get::<i32, _>("tier") < 2 {
        Some("Phone verification required. Management stopped.")
    } else {
        None
    };
    if let Some(reason) = stop {
        sqlx::query("UPDATE managed_positions SET enabled=false,status='stopped',last_error=$3,last_checked_at=NOW()
            WHERE user_id=$1 AND event_id=$2").bind(user).bind(event).bind(reason).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(None);
    }
    let belief: f64 = policy.get("belief_prob");
    let fraction: f64 = policy.get("kelly_fraction");
    let yes = holdings
        .as_ref()
        .map(|r| r.get::<f64, _>("yes_shares"))
        .unwrap_or(0.0);
    let no = holdings
        .as_ref()
        .map(|r| r.get::<f64, _>("no_shares"))
        .unwrap_or(0.0);
    let cash = from_ledger_units(account.get::<i64, _>("rp_balance_ledger") as i128);
    let mut market = Market {
        q_yes: row.get("q_yes"),
        q_no: row.get("q_no"),
        b: row.get("liquidity_b"),
    };
    let goal = target(market, cash, yes, no, belief, fraction)?;

    let held: bool = if config.market.enable_hold_period {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM market_updates WHERE user_id=$1 AND event_id=$2 AND hold_until>NOW())")
            .bind(user).bind(event).fetch_one(&mut *tx).await?
    } else {
        false
    };
    if held {
        sqlx::query("UPDATE managed_positions SET status='holding',last_error='Waiting for the purchase holding period to expire.',last_checked_at=NOW()
            WHERE user_id=$1 AND event_id=$2").bind(user).bind(event).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(None);
    }
    let mut actions = Vec::new();
    // Sell excess first. Both sides, plus the subsequent buy, commit atomically.
    for (side, have, want) in [(Side::Yes, yes, goal.yes), (Side::No, no, goal.no)] {
        let excess = (have - want).max(0.0).min(MAX_SHARES);
        if excess < 0.000001 {
            continue;
        }
        let mut after = market;
        let payout = if side == Side::Yes {
            after.sell_yes(excess)
        } else {
            after.sell_no(excess)
        }
        .map_err(|e| anyhow!(e))?;
        // Dust on the opposite side may be cleared when another leg trades.
        if from_ledger_units(payout) < MIN_TRADE_RP {
            continue;
        }
        let fill =
            lmsr_api::sell_shares_transaction(&mut tx, config, user, event, side, excess).await?;
        actions.push(format!(
            "Sold {:.4} {} for {:.2} RP",
            excess,
            side.as_str().to_uppercase(),
            fill.payout
        ));
        market = after;
    }
    for (side, have, want) in [(Side::Yes, yes, goal.yes), (Side::No, no, goal.no)] {
        let missing = (want - have).max(0.0).min(MAX_SHARES);
        if missing < 0.000001 {
            continue;
        }
        let mut after = market;
        if side == Side::Yes {
            after.q_yes += missing;
        } else {
            after.q_no += missing;
        }
        let cost = after.cost() - market.cost();
        // Floor to micro-RP, preserving affordability at the ledger boundary.
        let stake = ((cost * 1_000_000.0).floor() / 1_000_000.0).min(1_000_000.0);
        if stake < MIN_TRADE_RP {
            continue;
        }
        // A different side after selling would indicate an inconsistent target.
        if (side == Side::Yes) != (belief > market.prob_yes()) {
            bail!("Managed target direction mismatch");
        }
        let fill = lmsr_api::update_market_transaction(
            &mut tx,
            config,
            user,
            &lmsr_api::MarketUpdate {
                event_id: event,
                target_prob: belief,
                stake,
                referral_post_id: None,
                referral_click_id: None,
            },
        )
        .await?;
        actions.push(format!(
            "Bought {:.4} {} for {:.2} RP",
            fill.shares_acquired,
            side.as_str().to_uppercase(),
            stake
        ));
        if side == Side::Yes {
            market.q_yes += fill.shares_acquired;
        } else {
            market.q_no += fill.shares_acquired;
        }
    }
    let traded = !actions.is_empty();
    if traded {
        let summary = actions.join(". ");
        sqlx::query("INSERT INTO managed_position_activity(user_id,event_id,belief_prob,kelly_fraction,summary) VALUES($1,$2,$3,$4,$5)")
            .bind(user).bind(event).bind(belief).bind(fraction).bind(&summary).execute(&mut *tx).await?;
        sqlx::query("UPDATE managed_positions SET status='active',last_error=NULL,last_checked_at=NOW(),last_rebalanced_at=NOW(),last_trade_summary=$3
            WHERE user_id=$1 AND event_id=$2").bind(user).bind(event).bind(summary).execute(&mut *tx).await?;
    } else {
        sqlx::query(
            "UPDATE managed_positions SET status='active',last_error=NULL,last_checked_at=NOW()
            WHERE user_id=$1 AND event_id=$2",
        )
        .bind(user)
        .bind(event)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(traded.then_some(Adjustment {
        event_id: event,
        user_id: user,
        new_prob: market.prob_yes(),
    }))
}

/// Fixed-cadence caller; no recursive reaction to the trades it creates.
pub async fn run_due(pool: &PgPool, config: &Config, interval: u64) -> Result<Vec<Adjustment>> {
    let mut lease = pool.begin().await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(730901,1)")
        .fetch_one(&mut *lease)
        .await?;
    if !locked {
        return Ok(Vec::new());
    }
    let ready: bool = sqlx::query_scalar("SELECT to_regclass('managed_positions') IS NOT NULL")
        .fetch_one(&mut *lease)
        .await?;
    if !ready {
        return Ok(Vec::new());
    }
    let mut changes = Vec::new();
    loop {
        let due = sqlx::query("SELECT user_id,event_id FROM managed_positions WHERE enabled
        AND ($1=0 OR (updated_at<to_timestamp(floor(extract(epoch from NOW())/GREATEST($1,1))*GREATEST($1,1))
        AND (last_checked_at IS NULL OR last_checked_at<to_timestamp(floor(extract(epoch from NOW())/GREATEST($1,1))*GREATEST($1,1)))))
        ORDER BY last_checked_at NULLS FIRST,user_id,event_id LIMIT 128")
        .bind(interval as f64).fetch_all(&mut *lease).await?;
        if due.is_empty() {
            break;
        }
        for row in due {
            let user = row.get("user_id");
            let event = row.get("event_id");
            match rebalance(pool, config, user, event, interval).await {
                Ok(Some(change)) => changes.push(change),
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(user, event, error = %error, "Managed adjustment rolled back");
                    sqlx::query("UPDATE managed_positions SET status='error',last_error='Adjustment failed. No changes were made. Will retry at the next interval.',last_checked_at=NOW()
                    WHERE user_id=$1 AND event_id=$2 AND enabled")
                    .bind(user).bind(event).execute(pool).await?;
                }
            }
        }
        if interval == 0 {
            break;
        } // Unscheduled execution is only used by tests.
    }
    lease.commit().await?;
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn market(price: f64, b: f64) -> Market {
        Market {
            q_yes: b * (price / (1.0 - price)).ln(),
            q_no: 0.0,
            b,
        }
    }
    #[test]
    fn managed_kelly_matches_deep_liquidity_and_fraction() {
        let m = market(0.2, 1e8);
        let full = target(m, 1000.0, 0.0, 0.0, 0.3, 1.0).unwrap();
        // At fixed price, full Kelly invests 1000*(.3-.2)/.8 = 125 RP, or 625 shares.
        assert!((full.yes - 625.0).abs() < 0.1);
        let quarter = target(m, 1000.0, 0.0, 0.0, 0.3, 0.25).unwrap();
        assert!((quarter.yes - full.yes * 0.25).abs() < 1e-8);
        assert_eq!(quarter.no, 0.0);
    }
    #[test]
    fn managed_target_is_stable_after_own_trade() {
        for fraction in [0.25, 0.5, 1.0] {
            let m = market(0.2, 100.0);
            let first = target(m, 1000.0, 0.0, 0.0, 0.3, fraction).unwrap();
            let after = Market {
                q_yes: m.q_yes + first.yes,
                ..m
            };
            let cash = 1000.0 - (after.cost() - m.cost());
            assert!(cash > 0.0);
            let second = target(after, cash, first.yes, 0.0, 0.3, fraction).unwrap();
            assert!((first.yes - second.yes).abs() < 1e-8);
            assert!(after.prob_yes() < 0.3);
        }
    }
    #[test]
    fn managed_target_reverses_after_external_move_and_handles_both_sides() {
        let m = market(0.5, 5000.0);
        let goal = target(m, 950.0, 100.0, 0.0, 0.3, 0.25).unwrap();
        assert_eq!(goal.yes, 0.0);
        assert!(goal.no > 0.0);
        let neutral = target(
            Market {
                q_yes: 50.0,
                q_no: 50.0,
                b: 5000.0,
            },
            900.0,
            50.0,
            50.0,
            0.5,
            1.0,
        )
        .unwrap();
        assert_eq!(neutral.yes, 0.0);
        assert_eq!(neutral.no, 0.0);
    }
    #[test]
    fn managed_target_rejects_invalid_values() {
        for p in [0.0, 1.0, f64::NAN, f64::INFINITY] {
            assert!(target(market(0.2, 100.0), 100.0, 0.0, 0.0, p, 0.25).is_err());
        }
        assert!(target(market(0.2, 100.0), 100.0, 0.0, 0.0, 0.3, 0.3).is_err());
        assert!(target(market(0.2, 100.0), -1.0, 0.0, 0.0, 0.3, 0.25).is_err());
    }
}
