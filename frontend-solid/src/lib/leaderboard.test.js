import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeLeaderboardEntries, formatReputation } from './leaderboard.js';

test('shapeLeaderboardEntries unwraps a { leaderboard: [...] } envelope', () => {
  const rows = [{ user_id: 1 }, { user_id: 2 }];
  assert.equal(shapeLeaderboardEntries({ leaderboard: rows }), rows);
});

test('shapeLeaderboardEntries passes a bare array through unchanged', () => {
  const rows = [{ user_id: 7 }];
  assert.equal(shapeLeaderboardEntries(rows), rows);
});

test('shapeLeaderboardEntries maps null/undefined to an empty list', () => {
  assert.deepEqual(shapeLeaderboardEntries(null), []);
  assert.deepEqual(shapeLeaderboardEntries(undefined), []);
});

test('shapeLeaderboardEntries keeps an envelope whose leaderboard is not an array', () => {
  // Parity with the pre-extraction inline shaping: `res || []` — a truthy
  // non-envelope object is returned as-is, never coerced.
  const odd = { leaderboard: null, note: 'server contract violation' };
  assert.equal(shapeLeaderboardEntries(odd), odd);
});

test('formatReputation renders two decimals for numerics', () => {
  assert.equal(formatReputation(12.345), '12.35');
  assert.equal(formatReputation('3.1'), '3.10');
  assert.equal(formatReputation(0), '0.00');
});

test('formatReputation falls back to 0.00 for null, undefined and junk', () => {
  assert.equal(formatReputation(null), '0.00');
  assert.equal(formatReputation(undefined), '0.00');
  assert.equal(formatReputation('not-a-number'), '0.00');
  assert.equal(formatReputation(Infinity), '0.00');
});
