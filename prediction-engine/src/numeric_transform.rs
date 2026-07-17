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
}
