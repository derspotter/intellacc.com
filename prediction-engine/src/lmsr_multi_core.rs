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

// ---------------------------------------------------------------------
// Dense-bin vector trade core (numeric markets bundle math).
//
// See docs/superpowers/specs/2026-07-14-numeric-markets-design.md
// ("Bundle math") and the Codex consult (`...-codex-consult.md` §3) for the
// derivation. Given current market mass p, user target mass u, liquidity b:
//   d_i = b*ln(u_i/p_i)
//   exact (alpha=1) buy-only bundle: Δq_i = d_i - min_j d_j, cost = -min_i d_i
//   alpha-scaled bundle: Δq_i(alpha) = alpha*(d_i - min_j d_j), cost
//     S(alpha) = -alpha*min_i d_i + b*ln Σ_i p_i^(1-alpha) u_i^alpha
// ---------------------------------------------------------------------

/// C(q) = b * ln(sum exp(q_i/b)), computed via log-sum-exp with max-shift.
///
/// Thin alias over the existing `cost` helper above (used by
/// multiple-choice trading) so both callers share one LSE implementation
/// rather than duplicating it.
pub fn cost_multi(q: &[f64], b: f64) -> f64 {
    cost(q, b)
}

/// Current probabilities. Thin alias over the existing `probs` helper.
pub fn probabilities(q: &[f64], b: f64) -> Vec<f64> {
    probs(q, b)
}

/// One cost difference for a whole vector move; both terms via stable LSE
/// (each `cost_multi` call uses max-shift log-sum-exp internally).
pub fn apply_vector_cost(q: &[f64], delta_q: &[f64], b: f64) -> f64 {
    // Money path: this must never silently zip-truncate a mismatched-length
    // delta_q against q (which would understate/overstate the real cost), so
    // this is an always-on assert rather than a debug-only one.
    assert_eq!(
        q.len(),
        delta_q.len(),
        "q and delta_q must have the same length"
    );
    let q_after: Vec<f64> = q
        .iter()
        .zip(delta_q.iter())
        .map(|(qi, di)| qi + di)
        .collect();
    cost_multi(&q_after, b) - cost_multi(q, b)
}

/// Maximum allowed log-odds span (max_i d_i - min_i d_i) before a bundle
/// request is refused: beyond this the implied per-bin move is
/// astronomically large (ratios of e^40 or more) and is almost certainly a
/// degenerate/adversarial input rather than a meaningful trade. See
/// docs/superpowers/specs/2026-07-14-numeric-markets-codex-consult.md §2
/// ("Reject or clamp market log-odds spans beyond roughly 40b").
pub const MAX_LOG_ODDS_SPAN_B_MULTIPLE: f64 = 40.0;

/// Floor applied to each target mass `u_i` before renormalizing, so a
/// fully-zeroed target bin never produces `ln(0)`. Must stay in sync with
/// `distributionMath.js`'s `fitDistribution` floor on the frontend, which
/// previews the same target vector before it's sent to the engine.
///
/// Raised from 1e-9 to 1e-6 (see
/// docs/superpowers/specs/2026-07-14-numeric-markets-codex-consult.md and
/// task-10-report.md "Fix: Codex post-ship review"): at 1e-9, a full-alpha
/// trade concentrating mass into one bin sets every other bin's *prior*
/// probability to ~1e-9 (since alpha=1 moves p to floor-and-renormalize(u)
/// exactly). A subsequent full-alpha trade in the opposite direction then
/// pairs a ~1 target against a ~1e-9 prior (and vice versa), producing a
/// log-odds span of ~2*ln(1/1e-9) ≈ 41.4*b — just over the 40*b clamp — so
/// every quote against that market 400s forever. At 1e-6 the same
/// worst-case reversal spans ~2*ln(1/1e-6) ≈ 27.6*b, safely under the
/// clamp with ~12*b of headroom.
pub const TARGET_MASS_FLOOR: f64 = 1e-6;

/// d_i = b*ln(u_i/p_i); u floored at TARGET_MASS_FLOOR and renormalized first.
///
/// **Signature deviation from the Task 5 brief** (documented, per the
/// brief's own allowance): this returns `Result<Vec<f64>>` rather than a
/// bare `Vec<f64>` so it can reject inputs whose implied log-odds span
/// exceeds `MAX_LOG_ODDS_SPAN_B_MULTIPLE * b` instead of silently handing
/// back a degenerate delta. `bundle_cost` and `solve_alpha_for_budget`
/// call this internally and propagate the `Result` for the same reason;
/// their signatures gain `Result<..>` wrappers too.
pub fn target_deltas(p: &[f64], u: &[f64], b: f64) -> Result<Vec<f64>> {
    if p.len() != u.len() {
        return Err(anyhow!("p and u must have the same length"));
    }
    if p.len() < 2 {
        return Err(anyhow!("target_deltas needs at least 2 outcomes"));
    }
    if !b.is_finite() || b <= 0.0 {
        return Err(anyhow!("b must be positive and finite"));
    }
    if p.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return Err(anyhow!("all p_i must be finite and positive"));
    }
    if u.iter().any(|v| !v.is_finite()) {
        return Err(anyhow!("all u_i must be finite"));
    }

    // Floor at TARGET_MASS_FLOOR and renormalize, per spec, so a
    // fully-zeroed target bin never produces ln(0).
    let floored: Vec<f64> = u.iter().map(|v| v.max(TARGET_MASS_FLOOR)).collect();
    let sum: f64 = floored.iter().sum();
    if !sum.is_finite() || sum <= 0.0 {
        return Err(anyhow!("u renormalization failed: non-positive sum"));
    }

    let d: Vec<f64> = p
        .iter()
        .zip(floored.iter())
        .map(|(pi, ui)| b * ((ui / sum) / pi).ln())
        .collect();

    if d.iter().any(|v| !v.is_finite()) {
        return Err(anyhow!("target_deltas: computed a non-finite d_i"));
    }

    let max_d = d.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_d = d.iter().cloned().fold(f64::INFINITY, f64::min);
    let span = max_d - min_d;
    if span > MAX_LOG_ODDS_SPAN_B_MULTIPLE * b {
        return Err(anyhow!(
            "log-odds span {:.3} exceeds clamp of {}*b ({:.3})",
            span,
            MAX_LOG_ODDS_SPAN_B_MULTIPLE,
            MAX_LOG_ODDS_SPAN_B_MULTIPLE * b
        ));
    }

    Ok(d)
}

/// Buy-only exact bundle: d_i - min(d). Cost equals -min(d) (see
/// `bundle_cost(.., alpha=1.0)` / tests).
pub fn exact_bundle(d: &[f64]) -> Vec<f64> {
    let min_d = d.iter().cloned().fold(f64::INFINITY, f64::min);
    d.iter().map(|di| di - min_d).collect()
}

/// S(alpha) as in spec; monotone increasing in alpha on [0,1], S(0)=0,
/// S(1) = -min_i d_i.
///
/// Computed in log-domain (t_i = ln(p_i) + alpha*d_i/b, since
/// p_i^(1-alpha)*u_i^alpha = p_i * (u_i/p_i)^alpha = exp(ln(p_i) +
/// alpha*d_i/b)) via stable max-shifted log-sum-exp, so it never overflows
/// even for large |d_i| or alpha near 1.
pub fn bundle_cost(p: &[f64], u: &[f64], b: f64, alpha: f64) -> Result<f64> {
    if !(-1e-9..=1.0 + 1e-9).contains(&alpha) {
        return Err(anyhow!("alpha must be in [0,1], got {alpha}"));
    }
    let d = target_deltas(p, u, b)?;
    let min_d = d.iter().cloned().fold(f64::INFINITY, f64::min);

    let t: Vec<f64> = p
        .iter()
        .zip(d.iter())
        .map(|(pi, di)| pi.ln() + alpha * di / b)
        .collect();
    let max_t = t.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let sum_exp: f64 = t.iter().map(|ti| (ti - max_t).exp()).sum();
    let log_sum = max_t + sum_exp.ln();

    let s = -alpha * min_d + b * log_sum;
    if !s.is_finite() {
        return Err(anyhow!("bundle_cost: computed a non-finite result"));
    }
    Ok(s)
}

/// Largest alpha in [0,1] with round_to_ledger(bundle_cost) <= budget_ledger.
/// Bisection, 64 iterations, returns (alpha, cost_ledger, delta_q). Ledger
/// rounding reuses `lmsr_core::to_ledger_units` (round-half-away-from-zero
/// to `LEDGER_SCALE`) rather than duplicating rounding logic here.
pub fn solve_alpha_for_budget(
    p: &[f64],
    u: &[f64],
    b: f64,
    budget_ledger: i64,
) -> Result<(f64, i64, Vec<f64>)> {
    let d = target_deltas(p, u, b)?;
    let min_d = d.iter().cloned().fold(f64::INFINITY, f64::min);

    let ledger_cost_at = |alpha: f64| -> Result<i64> {
        let s = bundle_cost(p, u, b, alpha)?;
        let ledger = crate::lmsr_core::to_ledger_units(s).map_err(|e| anyhow!(e))?;
        i64::try_from(ledger).map_err(|_| anyhow!("bundle cost ledger value overflows i64"))
    };

    // Cap at alpha=1 (never buy complete sets / overshoot the target).
    let ledger_at_1 = ledger_cost_at(1.0)?;
    if ledger_at_1 <= budget_ledger {
        let delta_q: Vec<f64> = d.iter().map(|di| di - min_d).collect();
        return Ok((1.0, ledger_at_1, delta_q));
    }

    // Invariant maintained across the loop: ledger_cost_at(lo) <= budget_ledger
    // (true at lo=0.0, since S(0)=0 whenever budget_ledger >= 0) and
    // ledger_cost_at(hi) > budget_ledger (true at hi=1.0, checked above).
    let mut lo = 0.0f64;
    let mut hi = 1.0f64;
    for _ in 0..64 {
        let mid = 0.5 * (lo + hi);
        let ledger_mid = ledger_cost_at(mid)?;
        if ledger_mid <= budget_ledger {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    let alpha = lo;
    let cost_ledger = ledger_cost_at(alpha)?;
    let delta_q: Vec<f64> = d.iter().map(|di| alpha * (di - min_d)).collect();
    Ok((alpha, cost_ledger, delta_q))
}

/// `bin_count` equal-width bins over `[range_min, range_max]`; returns
/// `(lower, upper, label)` per bin. Labels are "lo–hi" (optionally suffixed
/// with `unit`), trimmed to sensible precision (integral bounds print with
/// no decimals; fractional bounds are formatted to 6 decimal places and
/// trailing zeros trimmed, which also absorbs float noise from repeated
/// bin-width addition).
pub fn linear_bins(
    range_min: f64,
    range_max: f64,
    bin_count: usize,
    unit: Option<&str>,
) -> Vec<(f64, f64, String)> {
    if bin_count == 0
        || !range_min.is_finite()
        || !range_max.is_finite()
        || range_max <= range_min
    {
        return Vec::new();
    }
    let width = (range_max - range_min) / bin_count as f64;
    (0..bin_count)
        .map(|i| {
            let lo = range_min + width * i as f64;
            // Last bin's upper bound is the exact range_max, not an
            // accumulated-float-error approximation of it.
            let hi = if i + 1 == bin_count {
                range_max
            } else {
                range_min + width * (i + 1) as f64
            };
            let label = format_bin_label(lo, hi, unit);
            (lo, hi, label)
        })
        .collect()
}

pub fn format_bin_number(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        return format!("{}", x as i64);
    }
    let s = format!("{:.6}", x);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

pub fn format_bin_label(lo: f64, hi: f64, unit: Option<&str>) -> String {
    let base = format!(
        "{}\u{2013}{}",
        format_bin_number(lo),
        format_bin_number(hi)
    );
    match unit {
        Some(u) if !u.is_empty() => format!("{base} {u}"),
        _ => base,
    }
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

/// Tests for the Task 5 dense-bin vector-trade math (`target_deltas`,
/// `exact_bundle`, `bundle_cost`, `solve_alpha_for_budget`, `linear_bins`,
/// plus the `cost_multi`/`probabilities`/`apply_vector_cost` helpers they
/// build on). Randomness is seeded (`StdRng::seed_from_u64`) so runs are
/// deterministic and reproducible.
#[cfg(test)]
mod vector_trade_tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    fn seeded_rng(seed: u64) -> StdRng {
        StdRng::seed_from_u64(seed)
    }

    /// A random point on the (n-1)-simplex: positive, sums to 1.
    fn random_simplex(rng: &mut impl Rng, n: usize) -> Vec<f64> {
        let w: Vec<f64> = (0..n).map(|_| rng.gen_range(0.01f64..1.0)).collect();
        let sum: f64 = w.iter().sum();
        w.into_iter().map(|wi| wi / sum).collect()
    }

    /// q_i = b*ln(p_i) reproduces probabilities(q, b) == p exactly (softmax
    /// of ln(p_i) is p_i / sum(p) = p_i since p already sums to 1), giving a
    /// concrete market state for an arbitrary target probability vector.
    fn q_from_p(p: &[f64], b: f64) -> Vec<f64> {
        p.iter().map(|pi| b * pi.ln()).collect()
    }

    fn to_ledger_units_i64(x: f64) -> i64 {
        i64::try_from(crate::lmsr_core::to_ledger_units(x).unwrap()).unwrap()
    }

    // "apply_vector_cost(q, exact_bundle(d), b) ≈ -min(d) (1e-9 rel) for
    // random p,u (seeded loop, 1000 draws, n=50)."
    #[test]
    fn exact_bundle_cost_matches_apply_vector_cost() {
        let mut rng = seeded_rng(1);
        let n = 50;
        let b = 5000.0;
        for draw in 0..1000 {
            let p = random_simplex(&mut rng, n);
            let u = random_simplex(&mut rng, n);
            let q = q_from_p(&p, b);

            let d = target_deltas(&p, &u, b).expect("generic simplex draws must not hit the span clamp");
            let delta = exact_bundle(&d);
            let cost = apply_vector_cost(&q, &delta, b);

            let min_d = d.iter().cloned().fold(f64::INFINITY, f64::min);
            let expected = -min_d;
            let diff = (cost - expected).abs();
            assert!(
                diff <= 1e-9 * expected.abs().max(1.0),
                "draw {draw}: cost {cost} vs expected {expected} (diff {diff})"
            );
        }
    }

    // "New probabilities after exact bundle ≈ u (1e-9)."
    #[test]
    fn exact_bundle_moves_probabilities_to_target() {
        let mut rng = seeded_rng(2);
        let n = 50;
        let b = 5000.0;
        for draw in 0..200 {
            let p = random_simplex(&mut rng, n);
            let u = random_simplex(&mut rng, n);
            let q = q_from_p(&p, b);

            let d = target_deltas(&p, &u, b).unwrap();
            let delta = exact_bundle(&d);
            let q_after: Vec<f64> = q.iter().zip(delta.iter()).map(|(qi, di)| qi + di).collect();
            let p_after = probabilities(&q_after, b);

            for (i, (pa, ui)) in p_after.iter().zip(u.iter()).enumerate() {
                assert!(
                    (pa - ui).abs() < 1e-9,
                    "draw {draw}, bin {i}: p_after {pa} vs target {ui}"
                );
            }
        }
    }

    // "bundle_cost monotone in α; S(0)=0; S(1)=−min d."
    #[test]
    fn bundle_cost_is_monotone_and_matches_endpoints() {
        let mut rng = seeded_rng(3);
        let n = 20;
        let b = 3000.0;
        for draw in 0..200 {
            let p = random_simplex(&mut rng, n);
            let u = random_simplex(&mut rng, n);
            let d = target_deltas(&p, &u, b).unwrap();
            let min_d = d.iter().cloned().fold(f64::INFINITY, f64::min);

            let s0 = bundle_cost(&p, &u, b, 0.0).unwrap();
            assert!(s0.abs() < 1e-7, "draw {draw}: S(0) should be ~0, got {s0}");

            let s1 = bundle_cost(&p, &u, b, 1.0).unwrap();
            assert!(
                (s1 - (-min_d)).abs() < 1e-6,
                "draw {draw}: S(1) {s1} vs -min(d) {}",
                -min_d
            );

            let alphas = [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
            let mut prev = f64::NEG_INFINITY;
            for &a in &alphas {
                let s = bundle_cost(&p, &u, b, a).unwrap();
                assert!(
                    s + 1e-9 >= prev,
                    "draw {draw}: bundle_cost must be monotone increasing: {s} < {prev} at alpha {a}"
                );
                prev = s;
            }
        }
    }

    // "solve_alpha_for_budget: cost_ledger ≤ budget; α maximal (α+ε would
    // exceed); budget ≥ S(1) → α=1 exactly."
    #[test]
    fn solve_alpha_for_budget_respects_budget_and_is_maximal() {
        let mut rng = seeded_rng(4);
        let n = 20;
        let b = 3000.0;
        for draw in 0..200 {
            let p = random_simplex(&mut rng, n);
            let u = random_simplex(&mut rng, n);
            let d = target_deltas(&p, &u, b).unwrap();
            let expected_full_delta = exact_bundle(&d);

            let s1 = bundle_cost(&p, &u, b, 1.0).unwrap();
            let ledger1 = to_ledger_units_i64(s1);

            // Budget covers the full move: alpha must land exactly on 1.0.
            let (alpha_full, cost_full, delta_full) =
                solve_alpha_for_budget(&p, &u, b, ledger1 + 1_000_000).unwrap();
            assert_eq!(alpha_full, 1.0, "draw {draw}: budget >= S(1) must give alpha == 1 exactly");
            assert_eq!(cost_full, ledger1, "draw {draw}: full-move cost_ledger should equal round_to_ledger(S(1))");
            for (i, (a, e)) in delta_full.iter().zip(expected_full_delta.iter()).enumerate() {
                assert!((a - e).abs() < 1e-9, "draw {draw}, bin {i}: delta_q mismatch at alpha=1");
            }

            // Constrained budget: respected, and maximal (nudging alpha up
            // by a small epsilon breaks the budget).
            let budget = (ledger1 as f64 * 0.4) as i64;
            if budget > 0 {
                let (alpha, cost_ledger, _delta) = solve_alpha_for_budget(&p, &u, b, budget).unwrap();
                assert!(
                    cost_ledger <= budget,
                    "draw {draw}: cost {cost_ledger} exceeds budget {budget}"
                );
                assert!(alpha < 1.0, "draw {draw}: constrained budget should not reach alpha=1");

                let bumped = (alpha + 1e-4).min(1.0);
                let bumped_ledger = to_ledger_units_i64(bundle_cost(&p, &u, b, bumped).unwrap());
                assert!(
                    bumped_ledger > budget,
                    "draw {draw}: alpha {alpha} should be maximal, but alpha+eps={bumped} still costs {bumped_ledger} <= budget {budget}"
                );
            }
        }
    }

    // "Permutation independence: shuffling bins and re-solving gives
    // permuted Δq, identical cost."
    #[test]
    fn solve_alpha_for_budget_is_permutation_independent() {
        let mut rng = seeded_rng(5);
        let n = 12;
        let b = 2000.0;
        let p = random_simplex(&mut rng, n);
        let u = random_simplex(&mut rng, n);
        let budget = 500_000_000i64; // 500 RP in ledger units.

        let (alpha1, cost1, delta1) = solve_alpha_for_budget(&p, &u, b, budget).unwrap();

        // A fixed permutation applied consistently to both p and u.
        let perm: Vec<usize> = (0..n).rev().collect();
        let p2: Vec<f64> = perm.iter().map(|&i| p[i]).collect();
        let u2: Vec<f64> = perm.iter().map(|&i| u[i]).collect();

        let (alpha2, cost2, delta2) = solve_alpha_for_budget(&p2, &u2, b, budget).unwrap();

        assert!(
            (alpha1 - alpha2).abs() < 1e-9,
            "alpha should be permutation-independent: {alpha1} vs {alpha2}"
        );
        assert_eq!(cost1, cost2, "ledger cost should be identical under permutation");
        for (idx, &orig_idx) in perm.iter().enumerate() {
            assert!(
                (delta2[idx] - delta1[orig_idx]).abs() < 1e-9,
                "delta_q must be permuted consistently at {idx} (from {orig_idx})"
            );
        }
    }

    // "Buy-then-inverse-sell at unchanged state:
    // apply_vector_cost(q, Δq) + apply_vector_cost(q+Δq, −Δq) == 0 exactly
    // in f64 terms ≤1e-9, and ≤1 ledger unit after independent roundings."
    #[test]
    fn apply_vector_cost_round_trip_is_zero() {
        let mut rng = seeded_rng(6);
        let n = 30;
        let b = 4000.0;
        for draw in 0..200 {
            let p = random_simplex(&mut rng, n);
            let q = q_from_p(&p, b);
            let delta: Vec<f64> = (0..n).map(|_| rng.gen_range(-50.0f64..50.0)).collect();
            let q_after: Vec<f64> = q.iter().zip(delta.iter()).map(|(qi, di)| qi + di).collect();
            let neg_delta: Vec<f64> = delta.iter().map(|d| -d).collect();

            let cost_forward = apply_vector_cost(&q, &delta, b);
            let cost_back = apply_vector_cost(&q_after, &neg_delta, b);

            assert!(
                (cost_forward + cost_back).abs() < 1e-9,
                "draw {draw}: float round trip drift {}",
                cost_forward + cost_back
            );

            let ledger_forward = to_ledger_units_i64(cost_forward);
            let ledger_back = to_ledger_units_i64(cost_back);
            assert!(
                (ledger_forward + ledger_back).abs() <= 1,
                "draw {draw}: ledger round trip drift exceeds 1 unit: {ledger_forward} + {ledger_back}"
            );
        }
    }

    // "Extreme spans: p with 1e-9 floor mass, u concentrated on one bin —
    // no NaN/inf"
    #[test]
    fn extreme_but_within_clamp_span_has_no_nan_or_inf() {
        let n = 50;
        let b = 5000.0;
        let mut p = vec![(1.0 - 1e-9) / (n as f64 - 1.0); n];
        p[0] = 1e-9;
        let mut u = vec![1e-9; n];
        u[0] = 1.0;

        let d = target_deltas(&p, &u, b).expect("this span should be just within the 40*b clamp");
        assert!(d.iter().all(|v| v.is_finite()), "d must be finite: {d:?}");

        let bundle = exact_bundle(&d);
        assert!(bundle.iter().all(|v| v.is_finite()), "exact_bundle must be finite");

        let s1 = bundle_cost(&p, &u, b, 1.0).expect("bundle_cost should succeed");
        assert!(s1.is_finite());

        let (alpha, cost_ledger, delta_q) =
            solve_alpha_for_budget(&p, &u, b, i64::MAX / 2).expect("solve_alpha_for_budget should succeed");
        assert!(alpha.is_finite());
        assert!(delta_q.iter().all(|v| v.is_finite()));
        let _ = cost_ledger;
    }

    // "...log-odds span clamp at 40·b rejects with error (Result type ok)."
    #[test]
    fn log_odds_span_beyond_clamp_is_rejected() {
        let n = 50;
        let b = 1.0;
        let mut p = vec![(1.0 - 1e-30) / (n as f64 - 1.0); n];
        p[0] = 1e-30;
        let mut u = vec![1e-9; n];
        u[1] = 1.0;

        assert!(
            target_deltas(&p, &u, b).is_err(),
            "span should exceed the 40*b clamp and be rejected"
        );
        assert!(
            bundle_cost(&p, &u, b, 1.0).is_err(),
            "bundle_cost must propagate the same span-clamp error"
        );
        assert!(
            solve_alpha_for_budget(&p, &u, b, 1_000_000).is_err(),
            "solve_alpha_for_budget must propagate the same span-clamp error"
        );
    }

    // Regression for the floor/clamp interaction bug fixed alongside
    // TARGET_MASS_FLOOR going from 1e-9 to 1e-6 (see that constant's doc
    // comment and task-10-report.md "Fix: Codex post-ship review"): a
    // narrow full-alpha trade that concentrates all mass into one bin sets
    // every other bin's *prior* probability to the target floor (alpha=1
    // moves p to floor-and-renormalize(u) exactly). An immediate,
    // opposite-direction narrow full-alpha trade must still be quotable —
    // at the old 1e-9 floor this pairing produced a ~41.4*b log-odds span
    // and 400'd forever; at 1e-6 it's ~27.6*b, safely under the 40*b clamp.
    #[test]
    fn full_alpha_reversal_after_floor_still_quotes() {
        let n = 10;
        let b = 100.0;
        let p0 = vec![1.0 / n as f64; n];

        // First trade: a narrow full-alpha buy concentrating everything
        // into bin 0. Every other bin's target mass is zero, so it gets
        // floored to TARGET_MASS_FLOOR by target_deltas/bundle_cost.
        let mut u_first = vec![0.0; n];
        u_first[0] = 1.0;
        target_deltas(&p0, &u_first, b).expect("first (concentrating) trade should quote");
        bundle_cost(&p0, &u_first, b, 1.0).expect("first trade alpha=1 cost must be finite");

        // Simulate the resulting market state: at alpha=1 the new prior is
        // exactly floor-and-renormalize(u_first) (see target_deltas doc
        // comment / exact_bundle_moves_probabilities_to_target).
        let sum_first: f64 = u_first.iter().map(|v: &f64| v.max(TARGET_MASS_FLOOR)).sum();
        let p1: Vec<f64> = u_first
            .iter()
            .map(|v| v.max(TARGET_MASS_FLOOR) / sum_first)
            .collect();
        assert!((p1.iter().sum::<f64>() - 1.0).abs() < 1e-9, "p1 must renormalize to 1");
        assert!(
            p1[1..].iter().all(|&v| (v - TARGET_MASS_FLOOR / sum_first).abs() < 1e-15),
            "every non-winning bin should have been floored"
        );

        // Second trade: reverse direction, concentrating into bin 1 — a
        // bin that was just floored to TARGET_MASS_FLOOR by the first
        // trade. This is the pathological pairing the floor raise fixes.
        let mut u_second = vec![0.0; n];
        u_second[1] = 1.0;

        let d_second = target_deltas(&p1, &u_second, b)
            .expect("opposite-direction full-alpha reversal must still quote after the floor fix");
        assert!(d_second.iter().all(|v| v.is_finite()));

        let max_d = d_second.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min_d = d_second.iter().cloned().fold(f64::INFINITY, f64::min);
        let span = max_d - min_d;
        assert!(
            span < MAX_LOG_ODDS_SPAN_B_MULTIPLE * b,
            "reversal span {span} should be safely under the {}*b clamp",
            MAX_LOG_ODDS_SPAN_B_MULTIPLE
        );

        let (alpha, cost_ledger, delta_q) = solve_alpha_for_budget(&p1, &u_second, b, i64::MAX / 2)
            .expect("solve_alpha_for_budget should succeed for the reversal");
        assert!(alpha.is_finite());
        assert!(delta_q.iter().all(|v| v.is_finite()));
        let _ = cost_ledger;
    }

    // "linear_bins(0,10,50,None): 50 bins, first (0,0.2), last (9.8,10),
    // contiguous, labels sane."
    #[test]
    fn linear_bins_produces_contiguous_equal_width_bins() {
        let bins = linear_bins(0.0, 10.0, 50, None);
        assert_eq!(bins.len(), 50);

        let (lo0, hi0, label0) = &bins[0];
        assert!((lo0 - 0.0).abs() < 1e-9);
        assert!((hi0 - 0.2).abs() < 1e-9);
        assert_eq!(label0, "0\u{2013}0.2");

        let (lo_last, hi_last, label_last) = &bins[49];
        assert!((lo_last - 9.8).abs() < 1e-9);
        assert!((hi_last - 10.0).abs() < 1e-9);
        assert_eq!(label_last, "9.8\u{2013}10");

        for i in 0..bins.len() - 1 {
            assert!(
                (bins[i].1 - bins[i + 1].0).abs() < 1e-9,
                "bins must be contiguous at index {i}"
            );
        }
        for (lo, hi, label) in &bins {
            assert!(hi > lo);
            assert!(!label.is_empty());
        }
    }

    #[test]
    fn linear_bins_appends_optional_unit_suffix() {
        let bins = linear_bins(0.0, 100.0, 4, Some("kg"));
        assert_eq!(bins.len(), 4);
        for (_, _, label) in &bins {
            assert!(label.ends_with("kg"), "label should end with unit: {label}");
        }
        assert_eq!(bins[0].2, "0\u{2013}25 kg");
    }

    #[test]
    fn linear_bins_handles_degenerate_input_without_panicking() {
        assert!(linear_bins(0.0, 10.0, 0, None).is_empty());
        assert!(linear_bins(10.0, 0.0, 5, None).is_empty());
        assert!(linear_bins(f64::NAN, 10.0, 5, None).is_empty());
    }
}
