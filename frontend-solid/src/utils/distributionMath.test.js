import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTransform,
  fitDistributionFromState,
  quantileFromState,
  niceTicks,
  chartXToNominal,
  pickNearestHandle,
  translateHandles,
  applySpreadPreset
} from './distributionMath.js';

const LOG_CFG = { range_min: 1, range_max: 10000, zero_point: 0, open_lower_bound: true, open_upper_bound: true };
const LIN_CFG = { range_min: 0, range_max: 4, zero_point: null, open_lower_bound: false, open_upper_bound: false };

const mkRows = (n, cfg) => {
  const tf = makeTransform(cfg);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      outcome_id: i + 1,
      bucket_kind: 'inbound',
      lower_bound: tf.toNominal(i / n),
      upper_bound: tf.toNominal((i + 1) / n),
      prob: 1 / n
    });
  }
  return rows;
};

test('makeTransform log matches the Metaculus identity 10^(4t)', () => {
  const tf = makeTransform(LOG_CFG);
  assert.ok(Math.abs(tf.toNominal(0.5) - 100) < 1e-6);
  assert.ok(Math.abs(tf.toInternal(10) - 0.25) < 1e-9);
});

test('makeTransform rejects degenerate configs', () => {
  assert.equal(makeTransform(null), null);
  assert.equal(makeTransform({ range_min: 0, range_max: 10, zero_point: 5 }), null); // zp inside range
  assert.equal(makeTransform({ range_min: 5, range_max: 1, zero_point: null }), null);
});

test('fitDistributionFromState pushes out-of-range mass into tails', () => {
  const rows = mkRows(4, LOG_CFG);
  rows.push({ outcome_id: 90, bucket_kind: 'lower_tail', lower_bound: null, upper_bound: 1, prob: 0 });
  rows.push({ outcome_id: 91, bucket_kind: 'upper_tail', lower_bound: 10000, upper_bound: null, prob: 0 });
  // Handles hug the very top of the range -> real mass must land in the upper tail.
  const u = fitDistributionFromState({ low: 5000, center: 9000, high: 9999, rows, config: LOG_CFG });
  assert.equal(u.length, 6);
  const sum = u.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(u[5] > 0.01, `upper tail got ${u[5]}`);
  assert.ok(u[4] < 1e-5, `lower tail should be floor-level, got ${u[4]}`);
});

test('fitDistributionFromState closed market renormalizes like the legacy fit', () => {
  const rows = mkRows(4, LIN_CFG);
  const u = fitDistributionFromState({ low: 1, center: 2, high: 3, rows, config: LIN_CFG });
  assert.equal(u.length, 4);
  assert.ok(Math.abs(u.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // symmetric handles on a linear market -> symmetric mass.
  // Tolerance 1e-7 accounts for erf approximation error (Abramowitz & Stegun 7.1.26 ~1.5e-7)
  // and floating-point accumulation through CDF evaluation + normalization.
  assert.ok(Math.abs(u[0] - u[3]) < 1e-7 && Math.abs(u[1] - u[2]) < 1e-7);
  assert.ok(u[1] > u[0]);
});

test('quantileFromState inverts a uniform distribution in t-space', () => {
  const rows = mkRows(4, LOG_CFG);
  // uniform mass over t -> P50 sits at t=0.5 -> nominal 100 on the log market
  const p50 = quantileFromState(rows, LOG_CFG, 0.5);
  assert.ok(Math.abs(p50 - 100) < 1, `got ${p50}`);
  // clamps into range even when tails hold mass
  rows.push({ outcome_id: 91, bucket_kind: 'upper_tail', lower_bound: 10000, upper_bound: null, prob: 0.5 });
  assert.ok(quantileFromState(rows, LOG_CFG, 0.99) <= 10000);
});

test('niceTicks picks decades on a pure log market', () => {
  const ticks = niceTicks(LOG_CFG, 5);
  assert.deepEqual(ticks.map((t) => t.value), [1, 10, 100, 1000, 10000]);
  // placement is in t-space: 100 sits at t=0.5 on this market
  const hundred = ticks.find((t) => t.value === 100);
  assert.ok(Math.abs(hundred.t - 0.5) < 1e-9);
});

test('niceTicks picks a nice linear step', () => {
  assert.deepEqual(niceTicks(LIN_CFG, 5).map((t) => t.value), [0, 1, 2, 3, 4]);
  // the 7000..14000 prod shape: nice step 2000
  const ticks = niceTicks({ range_min: 7000, range_max: 14000, zero_point: null }, 5);
  assert.deepEqual(ticks.map((t) => t.value), [8000, 10000, 12000, 14000]);
});

test('niceTicks degrades to empty on degenerate config', () => {
  assert.deepEqual(niceTicks(null, 5), []);
  assert.deepEqual(niceTicks({ range_min: 5, range_max: 1, zero_point: null }, 5), []);
});

test('chartXToNominal inverts the plot geometry on a linear market', () => {
  const geom = { plotLeft: 10, plotRight: 630, config: LIN_CFG };
  // midpoint of the plot -> midpoint of the range
  assert.ok(Math.abs(chartXToNominal(320, geom) - 2) < 1e-9);
  assert.ok(Math.abs(chartXToNominal(10, geom) - 0) < 1e-9);
  assert.ok(Math.abs(chartXToNominal(630, geom) - 4) < 1e-9);
});

test('chartXToNominal follows the log axis on a log market', () => {
  const geom = { plotLeft: 36, plotRight: 604, config: LOG_CFG };
  // t=0.5 on this market is nominal 100 (10^(4*0.5))
  const mid = chartXToNominal((36 + 604) / 2, geom);
  assert.ok(Math.abs(mid - 100) < 1e-6, `got ${mid}`);
  const quarter = chartXToNominal(36 + (604 - 36) * 0.25, geom);
  assert.ok(Math.abs(quarter - 10) < 1e-6, `got ${quarter}`);
});

test('chartXToNominal clamps tail-gutter clicks to the range edges', () => {
  const geom = { plotLeft: 36, plotRight: 604, config: LOG_CFG };
  assert.equal(chartXToNominal(0, geom), 1);      // left gutter -> range_min
  assert.equal(chartXToNominal(640, geom), 10000); // right gutter -> range_max
});

test('chartXToNominal returns null on degenerate geometry or config', () => {
  assert.equal(chartXToNominal(100, { plotLeft: 300, plotRight: 300, config: LIN_CFG }), null);
  assert.equal(chartXToNominal(100, { plotLeft: 10, plotRight: 630, config: null }), null);
});

test('pickNearestHandle picks the closest of the three guides', () => {
  const xs = { lowX: 100, centerX: 300, highX: 500 };
  assert.equal(pickNearestHandle(120, xs), 'low');
  assert.equal(pickNearestHandle(290, xs), 'center');
  assert.equal(pickNearestHandle(640, xs), 'high');
});

test('translateHandles rigidly translates the whole spread', () => {
  // linear market: nominal offsets are preserved verbatim
  const lin = translateHandles({ low: 1, center: 2, high: 3, newCenter: 1, config: LIN_CFG });
  assert.ok(Math.abs(lin.low - 0) < 1e-9 && lin.center === 1 && Math.abs(lin.high - 2) < 1e-9);
  // overshoot past the range edge is allowed — mass flows into the tail
  const over = translateHandles({ low: 1, center: 2, high: 3, newCenter: 0.5, config: LIN_CFG });
  assert.ok(Math.abs(over.low - -0.5) < 1e-9, `got ${over.low}`);
  // log market: offsets are preserved in t-space, not nominal space
  const log = translateHandles({ low: 10, center: 100, high: 1000, newCenter: 10, config: LOG_CFG });
  assert.ok(Math.abs(log.low - 1) < 1e-6, `got ${log.low}`);      // t 0.25 -> 0
  assert.ok(Math.abs(log.high - 100) < 1e-6, `got ${log.high}`);  // t 0.75 -> 0.5
});

test('applySpreadPreset scales the base spread in t-space without clamping', () => {
  // symmetric base, factor 2, centered: spreads double
  const wide = applySpreadPreset({ center: 2, baseLow: 1, baseCenter: 2, baseHigh: 3, factor: 2, config: LIN_CFG });
  assert.ok(Math.abs(wide.low - 0) < 1e-9 && Math.abs(wide.high - 4) < 1e-9);
  // off-center: NOT clamped at the range edge (that clamp used to make the
  // sigmas asymmetric and put a density cliff at the center handle)
  const off = applySpreadPreset({ center: 1, baseLow: 1, baseCenter: 2, baseHigh: 3, factor: 2, config: LIN_CFG });
  assert.ok(Math.abs(off.low - -1) < 1e-9, `got ${off.low}`);
  assert.ok(Math.abs(off.high - 3) < 1e-9, `got ${off.high}`);
  // factor 1 at the base center is idempotent — returns the base handles
  const med = applySpreadPreset({ center: 2, baseLow: 1, baseCenter: 2, baseHigh: 3, factor: 1, config: LIN_CFG });
  assert.ok(Math.abs(med.low - 1) < 1e-9 && Math.abs(med.high - 3) < 1e-9);
  // log market: scaling happens in t-space (10,100,1000 spans t 0.25..0.75,
  // so factor 2 spans t 0..1 — nominal 1..10000, NOT 100/10..1000*10)
  const log = applySpreadPreset({ center: 100, baseLow: 10, baseCenter: 100, baseHigh: 1000, factor: 2, config: LOG_CFG });
  assert.ok(Math.abs(log.low - 1) < 1e-6, `got ${log.low}`);
  assert.ok(Math.abs(log.high - 10000) < 1e-3, `got ${log.high}`);
});

test('fitDistributionFromState keeps the curve shape when handles are translated', () => {
  const rows = mkRows(20, LIN_CFG); // 0..4 linear, bin width 0.2
  // tails absorb the (tiny) out-of-range mass; without them, truncation +
  // renormalization perturbs the interior bins by ~1e-3 and hides the shift
  rows.push({ outcome_id: 90, bucket_kind: 'lower_tail', prob: 0 });
  rows.push({ outcome_id: 91, bucket_kind: 'upper_tail', prob: 0 });
  const before = fitDistributionFromState({ low: 1, center: 2, high: 3, rows, config: LIN_CFG });
  const moved = translateHandles({ low: 1, center: 2, high: 3, newCenter: 2.4, config: LIN_CFG });
  const after = fitDistributionFromState({ ...moved, rows, config: LIN_CFG });
  // translated by exactly 2 bins: the mass profile shifts, shape unchanged
  for (let i = 4; i < 14; i++) {
    assert.ok(Math.abs(after[i + 2] - before[i]) < 1e-6, `bin ${i}: ${before[i]} vs ${after[i + 2]}`);
  }
});

test('presets after a center drag produce no density cliff at the center (regression: market 6291)', () => {
  // 50-bin linear market like prod event 6291 (750k..950k, open tails)
  const cfg = { range_min: 750000, range_max: 950000, zero_point: null };
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push({ outcome_id: i, bucket_kind: 'inbound', lower_bound: 750000 + i * 4000, upper_bound: 750000 + (i + 1) * 4000, prob: 1 / 52 });
  }
  rows.push({ outcome_id: 90, bucket_kind: 'lower_tail', prob: 1 / 52 });
  rows.push({ outcome_id: 91, bucket_kind: 'upper_tail', prob: 1 / 52 });
  // base quantiles of the uniform market, center dragged to 800k, Wide preset
  const base = { baseLow: 766800, baseCenter: 850000, baseHigh: 933200 };
  const moved = translateHandles({ low: 766800, center: 850000, high: 933200, newCenter: 800000, config: cfg });
  const { low, high } = applySpreadPreset({ ...base, center: moved.center, factor: 2, config: cfg });
  const u = fitDistributionFromState({ low, center: moved.center, high, rows, config: cfg });
  const inbound = u.slice(0, 50);
  for (let i = 1; i < 50; i++) {
    const ratio = Math.max(inbound[i] / inbound[i - 1], inbound[i - 1] / inbound[i]);
    assert.ok(ratio < 1.2, `cliff at bin ${i}: ${inbound[i - 1]} -> ${inbound[i]}`);
  }
});

test('pickNearestHandle separates overlapping handles by click side', () => {
  // all three handles collapsed to one x: clicking left must grab low,
  // right must grab high, dead-on grabs center — otherwise a collapsed
  // spread could never be pulled apart on the chart.
  const xs = { lowX: 300, centerX: 300, highX: 300 };
  assert.equal(pickNearestHandle(200, xs), 'low');
  assert.equal(pickNearestHandle(400, xs), 'high');
  assert.equal(pickNearestHandle(300, xs), 'center');
});
