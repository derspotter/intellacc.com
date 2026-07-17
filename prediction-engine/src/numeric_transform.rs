//! Nominal <-> internal-coordinate mapping for numeric markets, following the
//! exact Metaculus transform (utils/the_math/formulas.py in their repo — see
//! docs/superpowers/specs/2026-07-17-open-tails-log-numeric-design.md).
//! Internal coordinate t is in [0,1]; bins are equal-width in t.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NumericTransform {
    pub range_min: f64,
    pub range_max: f64,
    pub zero_point: Option<f64>,
}

impl NumericTransform {
    fn span(&self) -> f64 {
        self.range_max - self.range_min
    }

    fn deriv_ratio(&self) -> Option<f64> {
        self.zero_point
            .map(|zp| (self.range_max - zp) / (self.range_min - zp))
    }

    pub fn validate(&self) -> Result<()> {
        if !self.range_min.is_finite() || !self.range_max.is_finite() {
            return Err(anyhow!("range bounds must be finite"));
        }
        if !(self.span() > 0.0) {
            return Err(anyhow!("range_max must exceed range_min"));
        }
        if let Some(zp) = self.zero_point {
            if !zp.is_finite() {
                return Err(anyhow!("zero_point must be finite"));
            }
            let d = self
                .deriv_ratio()
                .filter(|d| d.is_finite() && *d > 0.0)
                .ok_or_else(|| anyhow!("zero_point must lie strictly outside the range"))?;
            if (d - 1.0).abs() < 1e-12 || !d.ln().is_finite() {
                return Err(anyhow!("degenerate deriv_ratio for zero_point transform"));
            }
        }
        Ok(())
    }

    /// nominal -> t. Callers must have run validate(); on a degenerate shape
    /// this falls back to linear rather than returning NaN.
    pub fn to_internal(&self, x: f64) -> f64 {
        match self.deriv_ratio() {
            Some(d) if d > 0.0 && (d - 1.0).abs() >= 1e-12 => {
                (((x - self.range_min) * (d - 1.0) + self.span()).ln() - self.span().ln()) / d.ln()
            }
            _ => (x - self.range_min) / self.span(),
        }
    }

    /// t -> nominal.
    pub fn to_nominal(&self, t: f64) -> f64 {
        match self.deriv_ratio() {
            Some(d) if d > 0.0 && (d - 1.0).abs() >= 1e-12 => {
                self.range_min + self.span() * (d.powf(t) - 1.0) / (d - 1.0)
            }
            _ => self.range_min + self.span() * t,
        }
    }

    /// `bin_count` bins equal-width in t, returned as nominal (lower, upper)
    /// pairs. First lower and last upper are the exact range endpoints; the
    /// shared interior edges are computed once so bins are exactly contiguous.
    pub fn bin_edges_nominal(&self, bin_count: usize) -> Vec<(f64, f64)> {
        if bin_count == 0 || self.validate().is_err() {
            return Vec::new();
        }
        let mut edges = Vec::with_capacity(bin_count + 1);
        edges.push(self.range_min);
        for i in 1..bin_count {
            edges.push(self.to_nominal(i as f64 / bin_count as f64));
        }
        edges.push(self.range_max);
        (0..bin_count).map(|i| (edges[i], edges[i + 1])).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BucketKind {
    Inbound,
    LowerTail,
    UpperTail,
}

impl BucketKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "lower_tail" => BucketKind::LowerTail,
            "upper_tail" => BucketKind::UpperTail,
            _ => BucketKind::Inbound,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            BucketKind::Inbound => "inbound",
            BucketKind::LowerTail => "lower_tail",
            BucketKind::UpperTail => "upper_tail",
        }
    }
}

/// Winning outcome for a resolved nominal value, per the spec's semantics
/// table: strictly below range -> lower tail, strictly above -> upper tail,
/// exact endpoints land in the first/last inbound bin, interior values scan
/// [lower, upper) with the last inbound bin closed on its upper bound.
/// Ambiguous (overlapping inbound bins) or unmatchable values return None.
pub fn pick_winning_outcome(
    rows: &[(i64, BucketKind, Option<f64>, Option<f64>)],
    value: f64,
) -> Option<i64> {
    if !value.is_finite() || rows.is_empty() {
        return None;
    }
    let inbound: Vec<&(i64, BucketKind, Option<f64>, Option<f64>)> =
        rows.iter().filter(|r| r.1 == BucketKind::Inbound).collect();
    if inbound.is_empty() {
        return None;
    }
    // Inbound bins always carry bounds for numeric markets (the seeder writes
    // them); a missing endpoint here is corrupt data — fail safe with None.
    let range_min = inbound.first()?.2?;
    let range_max = inbound.last()?.3?;
    if value < range_min {
        return rows.iter().find(|r| r.1 == BucketKind::LowerTail).map(|r| r.0);
    }
    if value > range_max {
        return rows.iter().find(|r| r.1 == BucketKind::UpperTail).map(|r| r.0);
    }
    let last_idx = inbound.len() - 1;
    let mut matches = inbound.iter().enumerate().filter_map(|(idx, (id, _, lower, upper))| {
        let lower_ok = lower.map(|v| value >= v).unwrap_or(true);
        let upper_ok = upper
            .map(|v| if idx == last_idx { value <= v } else { value < v })
            .unwrap_or(true);
        (lower_ok && upper_ok).then_some(*id)
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        None // ambiguous — fail safe
    } else {
        Some(first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_tf() -> NumericTransform {
        // Metaculus-style pure log question: zero_point 0, range 1..10000.
        // With these params to_nominal(t) == 10^(4t) exactly (algebraic identity).
        NumericTransform { range_min: 1.0, range_max: 10000.0, zero_point: Some(0.0) }
    }
    fn lin_tf() -> NumericTransform {
        NumericTransform { range_min: 0.0, range_max: 4.0, zero_point: None }
    }

    #[test]
    fn linear_maps_are_plain_normalization() {
        let tf = lin_tf();
        assert!((tf.to_internal(1.0) - 0.25).abs() < 1e-12);
        assert!((tf.to_nominal(0.25) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn log_transform_matches_metaculus_formula() {
        let tf = log_tf();
        for (t, x) in [(0.0, 1.0), (0.25, 10.0), (0.5, 100.0), (0.75, 1000.0), (1.0, 10000.0)] {
            assert!((tf.to_nominal(t) - x).abs() < 1e-6, "to_nominal({t}) = {}", tf.to_nominal(t));
            assert!((tf.to_internal(x) - t).abs() < 1e-9, "to_internal({x}) = {}", tf.to_internal(x));
        }
    }

    #[test]
    fn round_trip_is_stable() {
        for tf in [log_tf(), lin_tf()] {
            for i in 0..=100 {
                let t = i as f64 / 100.0;
                assert!((tf.to_internal(tf.to_nominal(t)) - t).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn bin_edges_are_monotone_contiguous_and_endpoint_exact() {
        for tf in [log_tf(), lin_tf()] {
            let edges = tf.bin_edges_nominal(50);
            assert_eq!(edges.len(), 50);
            assert_eq!(edges[0].0, tf.range_min);           // exact, not approx
            assert_eq!(edges[49].1, tf.range_max);          // exact, not approx
            for i in 0..50 {
                assert!(edges[i].1 > edges[i].0);
                if i > 0 { assert_eq!(edges[i].0, edges[i - 1].1); } // contiguous
            }
        }
    }

    #[test]
    fn linear_edges_match_existing_linear_bins() {
        let tf = lin_tf();
        let ours = tf.bin_edges_nominal(4);
        let theirs = crate::lmsr_multi_core::linear_bins(0.0, 4.0, 4, None);
        for (a, b) in ours.iter().zip(theirs.iter()) {
            assert!((a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9);
        }
    }

    #[test]
    fn validate_rejects_degenerate_shapes() {
        // zero_point inside the range -> d < 0
        assert!(NumericTransform { range_min: 0.0, range_max: 10.0, zero_point: Some(5.0) }.validate().is_err());
        // zero_point == range_min -> division by zero
        assert!(NumericTransform { range_min: 1.0, range_max: 10.0, zero_point: Some(1.0) }.validate().is_err());
        // inverted range
        assert!(NumericTransform { range_min: 5.0, range_max: 1.0, zero_point: None }.validate().is_err());
        // non-finite
        assert!(NumericTransform { range_min: f64::NAN, range_max: 1.0, zero_point: None }.validate().is_err());
        // healthy shapes pass
        assert!(log_tf().validate().is_ok());
        assert!(lin_tf().validate().is_ok());
    }

    #[test]
    fn bucket_kind_parses_and_roundtrips() {
        assert_eq!(BucketKind::parse("lower_tail"), BucketKind::LowerTail);
        assert_eq!(BucketKind::parse("upper_tail"), BucketKind::UpperTail);
        assert_eq!(BucketKind::parse("inbound"), BucketKind::Inbound);
        assert_eq!(BucketKind::parse("anything-else"), BucketKind::Inbound);
        assert_eq!(BucketKind::LowerTail.as_str(), "lower_tail");
    }

    // Three contiguous, non-overlapping inbound bins: [0,10), [10,20), [20,30] -
    // the last one closed on both ends, matching linear_bins'/
    // seed_numeric_bins_if_missing's real shape. No tails configured.
    fn bins() -> Vec<(i64, BucketKind, Option<f64>, Option<f64>)> {
        vec![
            (1, BucketKind::Inbound, Some(0.0), Some(10.0)),
            (2, BucketKind::Inbound, Some(10.0), Some(20.0)),
            (3, BucketKind::Inbound, Some(20.0), Some(30.0)),
        ]
    }

    #[test]
    fn pick_winning_bin_range_min_goes_to_first_bin() {
        assert_eq!(pick_winning_outcome(&bins(), 0.0), Some(1));
    }

    #[test]
    fn pick_winning_bin_interior_value_goes_to_its_bin() {
        assert_eq!(pick_winning_outcome(&bins(), 5.0), Some(1));
        assert_eq!(pick_winning_outcome(&bins(), 15.0), Some(2));
        assert_eq!(pick_winning_outcome(&bins(), 25.0), Some(3));
    }

    #[test]
    fn pick_winning_bin_exact_boundary_goes_to_the_higher_bin() {
        // lower_bound <= v < upper_bound: a value exactly on the shared edge
        // between two bins belongs to the bin whose *lower* bound equals it,
        // not the one whose upper bound equals it.
        assert_eq!(pick_winning_outcome(&bins(), 10.0), Some(2));
        assert_ne!(pick_winning_outcome(&bins(), 10.0), Some(1));
        assert_eq!(pick_winning_outcome(&bins(), 20.0), Some(3));
        assert_ne!(pick_winning_outcome(&bins(), 20.0), Some(2));
    }

    #[test]
    fn pick_winning_bin_range_max_is_inclusive_on_the_final_bin() {
        // Only the last bin is closed on its upper end - v == range_max
        // resolves instead of falling off the edge.
        assert_eq!(pick_winning_outcome(&bins(), 30.0), Some(3));
    }

    #[test]
    fn pick_winning_bin_out_of_range_returns_none() {
        assert_eq!(pick_winning_outcome(&bins(), -0.001), None);
        assert_eq!(pick_winning_outcome(&bins(), 30.001), None);
    }

    #[test]
    fn pick_winning_bin_unparseable_or_non_finite_returns_none() {
        assert_eq!(pick_winning_outcome(&bins(), f64::NAN), None);
        assert_eq!(pick_winning_outcome(&bins(), f64::INFINITY), None);
        assert_eq!(pick_winning_outcome(&bins(), f64::NEG_INFINITY), None);
    }

    #[test]
    fn pick_winning_bin_empty_bins_returns_none() {
        assert_eq!(pick_winning_outcome(&[], 5.0), None);
    }

    #[test]
    fn pick_winning_bin_ambiguous_overlapping_bins_returns_none() {
        // Two active bins both claim value 5.0 - shouldn't happen for
        // well-formed data, but must fail safe (None) rather than silently
        // picking whichever row came first.
        let overlapping = vec![
            (1, BucketKind::Inbound, Some(0.0), Some(10.0)),
            (2, BucketKind::Inbound, Some(3.0), Some(8.0)),
        ];
        assert_eq!(pick_winning_outcome(&overlapping, 5.0), None);
        // Outside the overlap but still inside the overall (first-lower,
        // last-upper) range, still resolves normally.
        assert_eq!(pick_winning_outcome(&overlapping, 1.0), Some(1));
    }

    fn tailed_rows() -> Vec<(i64, BucketKind, Option<f64>, Option<f64>)> {
        vec![
            (1, BucketKind::Inbound, Some(0.0), Some(10.0)),
            (2, BucketKind::Inbound, Some(10.0), Some(20.0)),
            (3, BucketKind::LowerTail, None, Some(0.0)),
            (4, BucketKind::UpperTail, Some(20.0), None),
        ]
    }
    #[test]
    fn below_range_goes_to_lower_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), -0.5), Some(3)); }
    #[test]
    fn above_range_goes_to_upper_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), 20.5), Some(4)); }
    #[test]
    fn exact_range_min_goes_to_first_inbound_not_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), 0.0), Some(1)); }
    #[test]
    fn exact_range_max_goes_to_last_inbound_not_tail() { assert_eq!(pick_winning_outcome(&tailed_rows(), 20.0), Some(2)); }
    #[test]
    fn out_of_range_without_tails_is_none() {
        let closed = vec![
            (1, BucketKind::Inbound, Some(0.0), Some(10.0)),
            (2, BucketKind::Inbound, Some(10.0), Some(20.0)),
        ];
        assert_eq!(pick_winning_outcome(&closed, -1.0), None);
        assert_eq!(pick_winning_outcome(&closed, 21.0), None);
    }
}
