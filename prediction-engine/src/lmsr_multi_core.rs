//! N-outcome LMSR core for multiple choice and bucketed numeric markets.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone)]
pub struct MultiMarket {
    pub q: Vec<f64>,
    pub b: f64,
}

impl MultiMarket {
    pub fn new(q: Vec<f64>, b: f64) -> Result<Self> {
        if q.len() < 2 {
            return Err(anyhow!("multi-outcome market needs at least 2 outcomes"));
        }
        if !b.is_finite() || b <= 0.0 {
            return Err(anyhow!("liquidity parameter b must be positive and finite"));
        }
        if q.iter().any(|v| !v.is_finite()) {
            return Err(anyhow!("all q values must be finite"));
        }
        Ok(Self { q, b })
    }

    pub fn cost(&self) -> f64 {
        cost(&self.q, self.b)
    }

    pub fn probs(&self) -> Vec<f64> {
        probs(&self.q, self.b)
    }

    pub fn buy_outcome(&mut self, outcome_idx: usize, stake: f64) -> Result<(f64, f64)> {
        if !stake.is_finite() || stake <= 0.0 {
            return Err(anyhow!("stake must be positive and finite"));
        }
        if outcome_idx >= self.q.len() {
            return Err(anyhow!("invalid outcome index"));
        }
        let dq = delta_q_for_stake(outcome_idx, &self.q, self.b, stake)?;
        self.q[outcome_idx] += dq;
        Ok((dq, stake))
    }

    pub fn sell_outcome(&mut self, outcome_idx: usize, amount: f64) -> Result<f64> {
        let payout = sell_payout(outcome_idx, &self.q, self.b, amount)?;
        self.q[outcome_idx] -= amount;
        Ok(payout)
    }

}

pub fn cost(q: &[f64], b: f64) -> f64 {
    let max = q
        .iter()
        .map(|v| v / b)
        .fold(f64::NEG_INFINITY, |a, x| a.max(x));
    let sum_exp = q.iter().map(|v| ((v / b) - max).exp()).sum::<f64>();
    b * (max + sum_exp.ln())
}

pub fn probs(q: &[f64], b: f64) -> Vec<f64> {
    let max = q
        .iter()
        .map(|v| v / b)
        .fold(f64::NEG_INFINITY, |a, x| a.max(x));
    let exps: Vec<f64> = q.iter().map(|v| ((v / b) - max).exp()).collect();
    let denom = exps.iter().sum::<f64>().max(f64::MIN_POSITIVE);
    exps.into_iter().map(|v| v / denom).collect()
}

pub fn delta_q_for_stake(outcome_idx: usize, q: &[f64], b: f64, stake: f64) -> Result<f64> {
    if outcome_idx >= q.len() {
        return Err(anyhow!("invalid outcome index"));
    }
    if !stake.is_finite() || stake <= 0.0 {
        return Err(anyhow!("stake must be positive and finite"));
    }
    if q.iter().any(|v| !v.is_finite()) {
        return Err(anyhow!("all q values must be finite"));
    }
    if !b.is_finite() || b <= 0.0 {
        return Err(anyhow!("b must be positive and finite"));
    }

    let base_cost = cost(q, b);
    let mut lo = 0.0f64;
    let mut hi = (stake + b).max(1.0);

    // Expand upper bound until we bracket the solution.
    for _ in 0..40 {
        let mut q_try = q.to_vec();
        q_try[outcome_idx] += hi;
        let diff = cost(&q_try, b) - base_cost;
        if diff >= stake {
            break;
        }
        hi *= 2.0;
    }

    // Binary search.
    for _ in 0..80 {
        let mid = (lo + hi) * 0.5;
        let mut q_try = q.to_vec();
        q_try[outcome_idx] += mid;
        let diff = cost(&q_try, b) - base_cost;
        if diff >= stake {
            hi = mid;
        } else {
            lo = mid;
        }
    }

    let dq = hi;
    if !dq.is_finite() || dq <= 0.0 {
        return Err(anyhow!("failed to solve delta_q for stake"));
    }
    Ok(dq)
}

/// Payout for selling `amount` shares of one outcome: C(q) - C(q - amount*e_idx).
/// Holdings checks live at the API layer; this is pure market math.
pub fn sell_payout(outcome_idx: usize, q: &[f64], b: f64, amount: f64) -> Result<f64> {
    if outcome_idx >= q.len() {
        return Err(anyhow!("invalid outcome index"));
    }
    if !amount.is_finite() || amount <= 0.0 {
        return Err(anyhow!("amount must be positive and finite"));
    }
    if q.iter().any(|v| !v.is_finite()) {
        return Err(anyhow!("all q values must be finite"));
    }
    if !b.is_finite() || b <= 0.0 {
        return Err(anyhow!("b must be positive and finite"));
    }

    let before = cost(q, b);
    let mut q_after = q.to_vec();
    q_after[outcome_idx] -= amount;
    let payout = before - cost(&q_after, b);
    if !payout.is_finite() || payout < 0.0 {
        return Err(anyhow!("failed to compute sell payout"));
    }
    Ok(payout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_then_sell_round_trip_returns_stake_no_free_money() {
        let mut market = MultiMarket::new(vec![0.0; 4], 5000.0).unwrap();
        let stake = 100.0;
        let (shares, cost_paid) = market.buy_outcome(2, stake).unwrap();
        assert!(shares > 0.0);
        let payout = market.sell_outcome(2, shares).unwrap();
        // LMSR is path-independent: selling the exact shares bought must return
        // (within bisection tolerance) exactly the stake — and never more.
        assert!(
            (payout - cost_paid).abs() < 1e-6,
            "round trip mismatch: paid {cost_paid}, got back {payout}"
        );
    }

    #[test]
    fn partial_sell_moves_prob_down_and_probs_renormalize() {
        let mut market = MultiMarket::new(vec![0.0; 3], 5000.0).unwrap();
        let (shares, _) = market.buy_outcome(0, 500.0).unwrap();
        let prob_before = market.probs()[0];
        let payout = market.sell_outcome(0, shares / 2.0).unwrap();
        assert!(payout > 0.0);
        let probs = market.probs();
        assert!(probs[0] < prob_before, "selling must lower the sold outcome's prob");
        let sum: f64 = probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9, "probs must renormalize, got {sum}");
    }

    #[test]
    fn sell_payout_rejects_invalid_inputs() {
        let q = vec![0.0, 0.0];
        assert!(sell_payout(5, &q, 5000.0, 1.0).is_err(), "bad index");
        assert!(sell_payout(0, &q, 5000.0, 0.0).is_err(), "zero amount");
        assert!(sell_payout(0, &q, 5000.0, -1.0).is_err(), "negative amount");
        assert!(sell_payout(0, &q, 5000.0, f64::NAN).is_err(), "NaN amount");
        assert!(sell_payout(0, &q, 0.0, 1.0).is_err(), "bad liquidity");
    }
}
