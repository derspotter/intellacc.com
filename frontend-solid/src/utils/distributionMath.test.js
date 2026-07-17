import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTransform,
  fitDistributionFromState,
  quantileFromState,
  niceTicks
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
