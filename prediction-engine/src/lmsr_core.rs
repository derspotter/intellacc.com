//! src/lmsr_core.rs
//! Fast, numerically stable LMSR core with f64 math + fixed-point ledger (i128).
//!
//! Public surface intentionally small; extend as needed.

use std::fmt;

pub const LEDGER_SCALE: i128 = 1_000_000; // 1 micro-RP units

#[inline]
pub fn to_ledger_units(x: f64) -> i128 {
    // round half-away-from-zero
    if x.is_nan() || !x.is_finite() {
        panic!("non-finite value passed to to_ledger_units: {x}");
    }
    let scaled = x * (LEDGER_SCALE as f64);
    if scaled >= 0.0 {
        (scaled + 0.5).floor() as i128
    } else {
        (scaled - 0.5).ceil() as i128
    }
}

#[inline]
pub fn from_ledger_units(x: i128) -> f64 {
    x as f64 / LEDGER_SCALE as f64
}

/// Core LMSR market state.
#[derive(Clone, Copy)]
pub struct Market {
    pub q_yes: f64,
    pub q_no: f64,
    pub b: f64,
}

impl fmt::Debug for Market {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Market")
            .field("q_yes", &self.q_yes)
            .field("q_no", &self.q_no)
            .field("b", &self.b)
            .field("p_yes", &prob_yes(self.q_yes, self.q_no, self.b))
            .finish()
    }
}

impl Market {
    pub fn new(b: f64) -> Self {
        assert!(b.is_finite() && b > 0.0, "b must be positive and finite");
        Self { q_yes: 0.0, q_no: 0.0, b }
    }

    /// Convenience accessor.
    pub fn prob_yes(&self) -> f64 {
        prob_yes(self.q_yes, self.q_no, self.b)
    }

    pub fn cost(&self) -> f64 {
        cost(self.q_yes, self.q_no, self.b)
    }

    /// Unified trade executor for buying shares with stake (in ledger units).
    /// Returns (shares_bought, cash_debited_ledger).
    pub fn apply_trade(&mut self, side: Side, stake_ledger: i128) -> (f64, i128) {
        let stake = from_ledger_units(stake_ledger);
        assert!(stake > 0.0, "stake must be > 0");
        
        let pre_cost = self.cost();
        let shares_delta = delta_q_for_stake(side, self.q_yes, self.q_no, self.b, stake);
        
        // Apply the share delta to the appropriate side
        match side {
            Side::Yes => self.q_yes += shares_delta,
            Side::No => self.q_no += shares_delta,
        }
        
        let post_cost = self.cost();
        let cash_delta = post_cost - pre_cost; // what trader pays (positive)
        let cash_debit = to_ledger_units(cash_delta);
        
        (shares_delta, cash_debit)
    }

    /// Buy YES with a *stake* (in ledger units). Returns (shares_bought, cash_debited_ledger).
    pub fn buy_yes(&mut self, stake_ledger: i128) -> (f64, i128) {
        self.apply_trade(Side::Yes, stake_ledger)
    }

    /// Buy NO with a *stake* (in ledger units). Returns (shares_bought, cash_debited_ledger).
    pub fn buy_no(&mut self, stake_ledger: i128) -> (f64, i128) {
        self.apply_trade(Side::No, stake_ledger)
    }

    /// Unified sell executor for selling shares. Returns (cash_credited_ledger).
    pub fn apply_sell(&mut self, side: Side, shares: f64) -> i128 {
        assert!(shares > 0.0, "shares must be > 0");
        
        let pre_cost = self.cost();
        
        // Remove shares from the appropriate side
        match side {
            Side::Yes => self.q_yes -= shares,
            Side::No => self.q_no -= shares,
        }
        
        let post_cost = self.cost();
        let cash_delta = pre_cost - post_cost; // what trader receives (positive)
        to_ledger_units(cash_delta)
    }

    /// Sell YES `shares`. Returns (cash_credited_ledger).
    pub fn sell_yes(&mut self, shares: f64) -> i128 {
        self.apply_sell(Side::Yes, shares)
    }

    /// Sell NO `shares`. Returns (cash_credited_ledger).
    pub fn sell_no(&mut self, shares: f64) -> i128 {
        self.apply_sell(Side::No, shares)
    }
}

// -----------------------
// Numerically stable math
// -----------------------

#[inline]
pub fn log_sum_exp(a: f64, b: f64) -> f64 {
    let m = a.max(b);
    // if m is -inf (when both a,b are -inf), this still returns -inf
    m + ((a - m).exp() + (b - m).exp()).ln()
}

#[inline]
pub fn cost(q_yes: f64, q_no: f64, b: f64) -> f64 {
    assert!(b > 0.0 && b.is_finite(), "b invalid");
    let a = q_yes / b;
    let c = q_no / b;
    b * log_sum_exp(a, c)
}

#[inline]
pub fn prob_yes(q_yes: f64, q_no: f64, b: f64) -> f64 {
    let a = q_yes / b;
    let c = q_no / b;
    let m = a.max(c);
    let ey = (a - m).exp();
    let en = (c - m).exp();
    ey / (ey + en)
}

/// Market side for unified delta calculation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Yes,
    No,
}

impl Side {
    /// Parse from string (API boundary conversion)
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s.to_lowercase().as_str() {
            "yes" => Ok(Side::Yes),
            "no" => Ok(Side::No),
            _ => Err(format!("Invalid side: '{}', expected 'yes' or 'no'", s)),
        }
    }
    
    /// Convert to string for database storage
    pub fn to_string(&self) -> String {
        match self {
            Side::Yes => "yes".to_string(),
            Side::No => "no".to_string(),
        }
    }
    
    /// Convert to lowercase string slice (efficient for comparisons)
    pub fn as_str(&self) -> &'static str {
        match self {
            Side::Yes => "yes",
            Side::No => "no",
        }
    }
}

/// Unified closed-form delta calculation for buying shares with stake S.
/// 
/// For YES: dq_yes = b * ln((exp(S/b) * (A + B) - B) / A)
/// For NO:  dq_no  = b * ln((exp(S/b) * (A + B) - A) / B)
/// where A = exp(q_yes / b), B = exp(q_no / b)
#[inline]
pub fn delta_q_for_stake(side: Side, q_yes: f64, q_no: f64, b: f64, s: f64) -> f64 {
    assert!(s > 0.0, "stake must be positive");
    assert!(b > 0.0 && b.is_finite(), "b must be positive and finite");
    
    // Centralized overflow protection
    if s / b > 700.0 {
        panic!("stake too large relative to liquidity parameter: s/b = {}", s / b);
    }
    
    let a = (q_yes / b).exp();
    let n = (q_no / b).exp();
    let exp_sb = (s / b).exp();
    
    // Map (q_buy, q_other) and (exp_buy, exp_other) based on side
    let (numerator, denominator, side_name) = match side {
        Side::Yes => {
            // YES: subtract the other side (NO) from total
            let num = exp_sb * (a + n) - n;
            (num, a, "YES")
        }
        Side::No => {
            // NO: subtract the other side (YES) from total  
            let num = exp_sb * (a + n) - a;
            (num, n, "NO")
        }
    };
    
    assert!(numerator > 0.0 && denominator > 0.0, 
            "invalid delta calculation for {}: numerator={}, denominator={}", 
            side_name, numerator, denominator);
    
    b * (numerator / denominator).ln()
}

// Note: Removed duplicate delta_q_yes_for_stake and delta_q_no_for_stake functions
// Now using unified delta_q_for_stake with Side enum for DRY code

// -----------------------
// Tests
// -----------------------

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // Helper: do a random sequence of trades, then unwind, and assert float & ledger invariants.
    proptest! {
        #[test]
        fn round_trip_is_zero_cost(
            // keep ranges conservative; you can widen as you build more guards
            b in 1000.0f64..10_000.0,
            steps in 1usize..50,
            stakes in prop::collection::vec(1_000_000i128..100_000_000i128, 1..50), // up to 100 RP (1e6 scale) per step
            sides in prop::collection::vec(0u8..=1u8, 1..50),
        ) {
            let mut mkt = Market::new(b);
            let mut cash_float: f64 = 0.0;
            let mut cash_ledger: i128 = 0;

            let mut yes_shares: f64 = 0.0;
            let mut no_shares: f64 = 0.0;

            let n = steps.min(stakes.len()).min(sides.len());

            for i in 0..n {
                let stake_ledger = stakes[i];
                let stake = from_ledger_units(stake_ledger as i128).abs(); // ensure positive
                let stake_ledger = to_ledger_units(stake);
                let pre = mkt.cost();

                if sides[i] == 0 {
                    let (dq, cash_debit) = mkt.buy_yes(stake_ledger);
                    yes_shares += dq;
                    let post = mkt.cost();
                    let delta_c = post - pre;
                    cash_float += delta_c;
                    cash_ledger -= cash_debit; // user pays (cash leaves user)
                } else {
                    let (dq, cash_debit) = mkt.buy_no(stake_ledger);
                    no_shares += dq;
                    let post = mkt.cost();
                    let delta_c = post - pre;
                    cash_float += delta_c;
                    cash_ledger -= cash_debit; // user pays
                }

                // sanity
                prop_assert!(mkt.q_yes.is_finite() && mkt.q_no.is_finite());
            }

            // unwind positions
            let pre = mkt.cost();
            let cash_credit_yes = if yes_shares > 0.0 {
                mkt.sell_yes(yes_shares)
            } else { 0 };
            let cash_credit_no = if no_shares > 0.0 {
                mkt.sell_no(no_shares)
            } else { 0 };
            let post = mkt.cost();
            let delta_c_back = pre - post;

            cash_float -= delta_c_back; // user receives
            cash_ledger += cash_credit_yes + cash_credit_no; // user receives (credits)

            // Float math should be basically zero (epsilon)
            prop_assert!(cash_float.abs() < 1e-8, "float drift too large: {}", cash_float);

            // Ledger should be *exactly* zero after rounding
            prop_assert_eq!(cash_ledger, 0, "ledger imbalance: {}", cash_ledger);

            // Market should be back at initial q ~ 0 (within float)
            prop_assert!(mkt.q_yes.abs() < 1e-9);
            prop_assert!(mkt.q_no.abs() < 1e-9);
        }
    }

    #[test]
    fn prob_is_between_zero_and_one() {
        let mut m = Market::new(5000.0);
        for _ in 0..100 {
            let (_dq, _cash) = m.buy_yes(to_ledger_units(10.0));
            let p = m.prob_yes();
            assert!(p > 0.0 && p < 1.0, "p={}", p);
        }
    }

    #[test]
    fn simple_round_trip_exact_zero_ledger() {
        let mut m = Market::new(5000.0);
        let (dq, debit) = m.buy_yes(to_ledger_units(100.0));
        let credit = m.sell_yes(dq);
        assert_eq!(debit, credit, "round trip should net to zero in ledger units");
    }
}