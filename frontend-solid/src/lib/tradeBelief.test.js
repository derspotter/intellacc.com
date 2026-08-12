import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTradeSide, TRADE_EPS } from './tradeBelief.js';

test('belief above market buys YES', () => {
  assert.equal(deriveTradeSide(0.65, 0.48), 'yes');
});

test('belief below market buys NO', () => {
  assert.equal(deriveTradeSide(0.3, 0.48), 'no');
});

test('belief within epsilon of market yields no trade', () => {
  assert.equal(deriveTradeSide(0.501, 0.5), null);
  assert.equal(deriveTradeSide(0.5, 0.5), null);
});

test('difference of exactly epsilon trades', () => {
  assert.equal(deriveTradeSide(0.5 + TRADE_EPS, 0.5), 'yes');
  assert.equal(deriveTradeSide(0.5 - TRADE_EPS, 0.5), 'no');
});

test('non-finite inputs yield no trade', () => {
  assert.equal(deriveTradeSide(NaN, 0.5), null);
  assert.equal(deriveTradeSide(0.6, undefined), null);
  assert.equal(deriveTradeSide('abc', 0.5), null);
});
