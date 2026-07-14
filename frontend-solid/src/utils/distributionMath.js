// Pure math for the numeric-market distribution editor (DistributionMarketCard).
// No DOM, no Solid reactivity — safe to unit-test in isolation and to reuse
// from a jest-less assert page if one is ever added.

// LEDGER_SCALE mirrors prediction-engine/src/lmsr_core.rs::LEDGER_SCALE. All
// money crossing the API boundary is integer ledger units; RP is the display
// unit. Keep both directions here so call sites never hand-roll the factor.
export const LEDGER_SCALE = 1_000_000;

export const rpToLedger = (rp) => Math.round(Number(rp) * LEDGER_SCALE);
export const ledgerToRp = (ledger) => Number(ledger) / LEDGER_SCALE;

// z-score such that Φ(-Z90) = 0.10 and Φ(Z90) = 0.90 for the standard normal.
const Z90 = 1.2816;

/**
 * erf approximation, Abramowitz & Stegun 7.1.26.
 * Max absolute error ~1.5e-7 over all real x — plenty for a UI curve fit.
 */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const y = 1 - poly * Math.exp(-ax * ax);
  return sign * y;
}

// Standard normal CDF via erf.
export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Split-normal CDF: a valid, continuous, monotone CDF built from two
 * standard-normal CDFs sharing the same center but different scales on each
 * side. Unlike a "proper" two-piece-normal density (which needs an extra
 * sigma1/(sigma1+sigma2) mixing factor to integrate to 1, at the cost of no
 * longer hitting the P10/P90 handles exactly), this direct piecewise
 * definition guarantees CDF(low) == 0.10 and CDF(high) == 0.90 by
 * construction whenever sigmaLeft/sigmaRight were derived from (center-low)
 * and (high-center) via the Z90 z-score — which is the whole point of a
 * three-handle (low/center/high) editor: what the user drags is exactly what
 * they get back out.
 */
export function splitNormalCdf(x, center, sigmaLeft, sigmaRight) {
  const sigma = x < center ? sigmaLeft : sigmaRight;
  return normalCdf((x - center) / sigma);
}

/**
 * Left/right sigmas from the three handles, floored to avoid a
 * divide-by-zero / degenerate (near-Dirac) curve when handles coincide
 * (e.g. low === center, or a user drags high below center transiently).
 * Floor is (rangeMax-rangeMin)/1000 per the design brief.
 */
export function computeSigmas(low, center, high, rangeMin, rangeMax) {
  const span = Math.max(rangeMax - rangeMin, Number.EPSILON);
  const floor = span / 1000;
  const sigmaLeft = Math.max((center - low) / Z90, floor);
  const sigmaRight = Math.max((high - center) / Z90, floor);
  return { sigmaLeft, sigmaRight };
}

/**
 * Fit a split-normal to (low, center, high) = (P10, P50, P90) and integrate
 * its CDF over each bin's [lower_bound, upper_bound) edges to get a
 * probability mass per bin. Bins must be given in ascending, contiguous
 * order (as returned by the market-state endpoint).
 *
 * Mass outside [rangeMin, rangeMax] (the split-normal's tails) is simply not
 * counted — bins are floored at 1e-9 and the whole vector is renormalized to
 * sum to 1, per the design brief.
 */
export function fitDistribution({ low, center, high, rangeMin, rangeMax, bins }) {
  if (!Array.isArray(bins) || bins.length === 0) return [];
  const { sigmaLeft, sigmaRight } = computeSigmas(low, center, high, rangeMin, rangeMax);

  const raw = bins.map(({ lower_bound, upper_bound }) => {
    const cdfUpper = splitNormalCdf(Number(upper_bound), center, sigmaLeft, sigmaRight);
    const cdfLower = splitNormalCdf(Number(lower_bound), center, sigmaLeft, sigmaRight);
    return Math.max(cdfUpper - cdfLower, 0);
  });

  const floored = raw.map((v) => (Number.isFinite(v) ? Math.max(v, 1e-9) : 1e-9));
  const sum = floored.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    // Should be unreachable (floor guarantees sum >= bins.length * 1e-9), but
    // never hand back NaN/Inf to the caller — fall back to uniform.
    return bins.map(() => 1 / bins.length);
  }
  return floored.map((v) => v / sum);
}

/**
 * Quantile (0..1) of a discrete per-bin distribution, via linear
 * interpolation within the bin whose cumulative mass first reaches q. Used
 * to initialize the low/center/high handles from the market's current
 * quartiles (P10/P50/P90) rather than starting the editor blank.
 */
export function quantileFromBins(bins, q) {
  if (!Array.isArray(bins) || bins.length === 0) return 0;
  let cumulative = 0;
  for (const bin of bins) {
    const mass = Math.max(Number(bin.prob) || 0, 0);
    if (cumulative + mass >= q) {
      const lower = Number(bin.lower_bound);
      const upper = Number(bin.upper_bound);
      const frac = mass > 0 ? (q - cumulative) / mass : 0;
      return lower + frac * (upper - lower);
    }
    cumulative += mass;
  }
  return Number(bins[bins.length - 1].upper_bound);
}

/**
 * Preset narrow/medium/wide handle placements. Scales the *original*
 * low/high spread around the *current* center by `factor` (0.5 / 1 / 2),
 * so repeated preset clicks are idempotent rather than compounding.
 * Caller is responsible for clamping the result into [rangeMin, rangeMax].
 */
export function applySpreadPreset({ center, baseLow, baseCenter, baseHigh, factor }) {
  const leftSpread = (baseCenter - baseLow) * factor;
  const rightSpread = (baseHigh - baseCenter) * factor;
  return { low: center - leftSpread, high: center + rightSpread };
}
