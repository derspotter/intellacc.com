import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KELLY_FRACTIONS,
  DEFAULT_KELLY_FRACTION,
  normalizeKellyFraction,
  fullKellyFromSuggestion,
  stakeForFraction,
  beliefTrackGradient,
} from './kellyStake.js';

test('fractions offered are quarter, half and full, defaulting to quarter', () => {
  assert.deepEqual(KELLY_FRACTIONS, [0.25, 0.5, 1]);
  assert.equal(DEFAULT_KELLY_FRACTION, 0.25);
});

test('normalizeKellyFraction accepts only the offered fractions', () => {
  assert.equal(normalizeKellyFraction(0.5), 0.5);
  assert.equal(normalizeKellyFraction('1'), 1);
  assert.equal(normalizeKellyFraction(0.3), 0.25);
  assert.equal(normalizeKellyFraction(null), 0.25);
  assert.equal(normalizeKellyFraction('garbage'), 0.25);
});

test('fullKellyFromSuggestion prefers the engine full_kelly field', () => {
  assert.equal(fullKellyFromSuggestion({ full_kelly: 80, kelly_suggestion: 20 }), 80);
});

test('fullKellyFromSuggestion derives full Kelly from a fractional suggestion', () => {
  // Engine reports the configured fraction alongside the (already scaled) suggestion.
  assert.equal(fullKellyFromSuggestion({ kelly_suggestion: 20, kelly_fraction: 0.25 }), 80);
  // Older engine without the fraction: assume the historical quarter default.
  assert.equal(fullKellyFromSuggestion({ kelly_suggestion: 20 }), 80);
  assert.equal(fullKellyFromSuggestion(null), 0);
  assert.equal(fullKellyFromSuggestion({ kelly_suggestion: 'nan' }), 0);
});

test('stakeForFraction scales full Kelly and caps at balance', () => {
  assert.equal(stakeForFraction(80, 0.25, 1000), '20.00');
  assert.equal(stakeForFraction(80, 1, 1000), '80.00');
  assert.equal(stakeForFraction(5000, 1, 1000), '1000.00');
  assert.equal(stakeForFraction(0, 1, 1000), '');
  assert.equal(stakeForFraction(-3, 1, 1000), '');
  assert.equal(stakeForFraction(NaN, 0.5, 1000), '');
});

test('beliefTrackGradient puts the neutral colour exactly at the market price', () => {
  const css = beliefTrackGradient(0.3, { no: '#d00', mid: '#fff', yes: '#0a0' });
  assert.equal(css, 'linear-gradient(to right, #d00 0%, #fff 30%, #0a0 100%)');
});

test('beliefTrackGradient clamps and falls back to 50% for bad input', () => {
  assert.match(beliefTrackGradient(1.7, { no: 'a', mid: 'b', yes: 'c' }), / b 100%, /);
  assert.match(beliefTrackGradient('x', { no: 'a', mid: 'b', yes: 'c' }), / b 50%, /);
});
