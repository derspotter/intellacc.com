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

// Must match TARGET_MASS_FLOOR in prediction-engine/src/lmsr_multi_core.rs —
// this previews the same target vector the engine floors server-side.
// Raised from 1e-9 to 1e-6: see that constant's doc comment for why (a
// full-alpha trade at the old floor could push the market's log-odds span
// past the 40*b clamp on a subsequent opposite-direction trade).
const TARGET_MASS_FLOOR = 1e-6;

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

/**
 * Transform between nominal values and Metaculus's internal coordinate
 * t in [0,1]. zero_point == null means linear. Formulas are verbatim from
 * Metaculus utils/the_math/formulas.py (see the 2026-07-17 design spec) —
 * with d = (range_max - zero_point) / (range_min - zero_point).
 * Returns null for missing or degenerate configs (caller falls back).
 */
export function makeTransform(config) {
  if (!config) return null;
  const rangeMin = Number(config.range_min);
  const rangeMax = Number(config.range_max);
  const zeroPoint = config.zero_point == null ? null : Number(config.zero_point);
  const span = rangeMax - rangeMin;
  if (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax) || !(span > 0)) return null;
  if (zeroPoint == null) {
    return {
      rangeMin,
      rangeMax,
      toInternal: (x) => (x - rangeMin) / span,
      toNominal: (t) => rangeMin + span * t
    };
  }
  if (!Number.isFinite(zeroPoint)) return null;
  const d = (rangeMax - zeroPoint) / (rangeMin - zeroPoint);
  if (!Number.isFinite(d) || d <= 0 || Math.abs(d - 1) < 1e-12) return null;
  const lnD = Math.log(d);
  return {
    rangeMin,
    rangeMax,
    toInternal: (x) => (Math.log((x - rangeMin) * (d - 1) + span) - Math.log(span)) / lnD,
    toNominal: (t) => rangeMin + span * (Math.pow(d, t) - 1) / (d - 1)
  };
}

const rowKind = (row) => row?.bucket_kind || 'inbound';
const inboundOf = (rows) => rows.filter((r) => rowKind(r) === 'inbound');

// Linear fallback transform derived from inbound bin bounds, for stale
// backends that don't send numeric_config yet (degraded display, not a
// correctness risk — see the design spec's Error handling section).
const fallbackTransform = (rows) => {
  const inbound = inboundOf(rows);
  if (inbound.length === 0) return null;
  return makeTransform({
    range_min: Number(inbound[0].lower_bound),
    range_max: Number(inbound[inbound.length - 1].upper_bound),
    zero_point: null
  });
};

/**
 * Split-normal fit in t-space. Returns one mass per row, aligned with the
 * given rows order (market-state order: inbound bins then tails). Mass below
 * t=0 / above t=1 goes to the lower/upper tail row when present and is
 * dropped otherwise; the vector is floored at TARGET_MASS_FLOOR and
 * renormalized to 1 (identical to the legacy closed-market behavior).
 */
export function fitDistributionFromState({ low, center, high, rows, config }) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const tf = makeTransform(config) || fallbackTransform(rows);
  if (!tf) return rows.map(() => 1 / rows.length);
  const n = inboundOf(rows).length;
  if (n === 0) return rows.map(() => 1 / rows.length);

  const tc = tf.toInternal(center);
  const { sigmaLeft, sigmaRight } = computeSigmas(
    tf.toInternal(low), tc, tf.toInternal(high), 0, 1
  );
  const cdf = (t) => splitNormalCdf(t, tc, sigmaLeft, sigmaRight);

  let inboundIdx = 0;
  const raw = rows.map((row) => {
    const kind = rowKind(row);
    if (kind === 'lower_tail') return Math.max(cdf(0), 0);
    if (kind === 'upper_tail') return Math.max(1 - cdf(1), 0);
    const i = inboundIdx;
    inboundIdx += 1;
    return Math.max(cdf((i + 1) / n) - cdf(i / n), 0);
  });

  const floored = raw.map((v) => (Number.isFinite(v) ? Math.max(v, TARGET_MASS_FLOOR) : TARGET_MASS_FLOOR));
  const sum = floored.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return rows.map(() => 1 / rows.length);
  return floored.map((v) => v / sum);
}

/**
 * Quantile of the market's current per-row distribution, computed in t-space
 * (walk order: lower tail, inbound bins, upper tail) and returned as a
 * nominal value clamped into [rangeMin, rangeMax] — tail mass "lands" on the
 * nearest range endpoint since tails have no interior coordinates.
 */
export function quantileFromState(rows, config, q) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const tf = makeTransform(config) || fallbackTransform(rows);
  if (!tf) return 0;
  const inbound = inboundOf(rows);
  const n = inbound.length;
  const lowerTail = rows.find((r) => rowKind(r) === 'lower_tail');
  const upperTail = rows.find((r) => rowKind(r) === 'upper_tail');
  const mass = (row) => Math.max(Number(row?.prob) || 0, 0);

  let cumulative = mass(lowerTail || {});
  if (cumulative >= q) return tf.rangeMin;
  for (let i = 0; i < n; i++) {
    const m = mass(inbound[i]);
    if (cumulative + m >= q) {
      const frac = m > 0 ? (q - cumulative) / m : 0;
      return tf.toNominal((i + frac) / n);
    }
    cumulative += m;
  }
  return upperTail ? tf.rangeMax : tf.toNominal(1);
}

/**
 * ~`target` axis ticks at nice nominal values (1-2-5 progression), returned
 * as [{ t, value }] with t-space placement for the chart. Log markets get
 * 1-2-5 mantissa candidates in the zero_point-shifted coordinate, thinned
 * evenly in log space; linear markets get a standard nice-step ladder.
 * Degenerate configs return [] (the card simply renders no tick labels).
 */
export function niceTicks(config, target = 5) {
  const tf = makeTransform(config);
  if (!tf) return [];
  const { rangeMin, rangeMax } = tf;
  const zeroPoint = config.zero_point == null ? null : Number(config.zero_point);

  let values;
  if (zeroPoint != null) {
    // Work in shifted space s = x - zero_point (same sign across the range,
    // guaranteed by makeTransform's deriv_ratio validation).
    const sMin = rangeMin - zeroPoint;
    const sMax = rangeMax - zeroPoint;
    const sign = sMin < 0 ? -1 : 1;
    const lo = Math.min(Math.abs(sMin), Math.abs(sMax));
    const hi = Math.max(Math.abs(sMin), Math.abs(sMax));
    const candidates = [];
    for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
      for (const m of [1, 2, 5]) {
        const s = sign * m * Math.pow(10, k);
        const x = s + zeroPoint;
        if (x >= rangeMin && x <= rangeMax) candidates.push(x);
      }
    }
    candidates.sort((a, b) => a - b);
    if (candidates.length <= target) {
      values = candidates;
    } else {
      values = [];
      for (let i = 0; i < target; i++) {
        values.push(candidates[Math.round((i * (candidates.length - 1)) / (target - 1))]);
      }
      values = [...new Set(values)];
    }
  } else {
    const span = rangeMax - rangeMin;
    const rawStep = span / (target - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    values = [];
    for (let v = Math.ceil(rangeMin / step) * step; v <= rangeMax + step * 1e-9; v += step) {
      values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
  }
  return values.map((value) => ({ t: tf.toInternal(value), value }));
}

/**
 * Inverse of the card's toX(): a viewBox x-coordinate back to the nominal
 * value under it. Clicks left/right of the plot (tail gutters, padding)
 * clamp to the range edges — the P10/P50/P90 handles can't live inside a
 * tail bucket. Returns null on degenerate geometry or config (caller
 * ignores the pointer event).
 */
export function chartXToNominal(x, { plotLeft, plotRight, config }) {
  const tf = makeTransform(config);
  if (!tf) return null;
  const span = plotRight - plotLeft;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(Number(x))) return null;
  const t = Math.min(Math.max((x - plotLeft) / span, 0), 1);
  return tf.toNominal(t);
}

/**
 * Which of the three guide lines a pointer-down at viewBox x should grab.
 * Ties (overlapping handles) resolve by click side — left grabs 'low',
 * right grabs 'high', dead-on grabs 'center' — so a collapsed spread can
 * still be pulled apart on the chart.
 */
export function pickNearestHandle(x, { lowX, centerX, highX }) {
  const dLow = Math.abs(x - lowX);
  const dCenter = Math.abs(x - centerX);
  const dHigh = Math.abs(x - highX);
  const min = Math.min(dLow, dCenter, dHigh);
  const tied = [
    dLow === min ? 'low' : null,
    dCenter === min ? 'center' : null,
    dHigh === min ? 'high' : null
  ].filter(Boolean);
  if (tied.length === 1) return tied[0];
  const tiedX = tied[0] === 'low' ? lowX : tied[0] === 'center' ? centerX : highX;
  if (x < tiedX && tied.includes('low')) return 'low';
  if (x > tiedX && tied.includes('high')) return 'high';
  return tied.includes('center') ? 'center' : tied[0];
}
