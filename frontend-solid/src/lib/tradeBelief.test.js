import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTradeSide, TRADE_EPS, snapBeliefToMarket, parseBeliefPercent, formatBeliefPercent } from './tradeBelief.js';

test('snapped market values display one decimal without rounding the actual belief', () => {
  const market = 0.570669;
  const snapped = snapBeliefToMarket(0.575, market);
  assert.equal(snapped, market);
  assert.equal(formatBeliefPercent(snapped, market), '57.1');
  assert.equal(formatBeliefPercent(0.5725, market), '57.25');
});

test('slider snaps within one percentage point of the market, not 50%', () => {
  for (const belief of [0.561, 0.568, 0.571, 0.578, 0.581]) {
    assert.equal(snapBeliefToMarket(belief, 0.571), 0.571);
  }
  for (const belief of [0.5, 0.56, 0.582]) {
    assert.equal(snapBeliefToMarket(belief, 0.571), belief);
  }
  assert.equal(snapBeliefToMarket(0.99, 0.999), 0.99);
  assert.equal(snapBeliefToMarket(0.5, NaN), 0.5);
});

test('typed percentages preserve decimals without snapping and reject invalid values', () => {
  assert.equal(parseBeliefPercent('57.25'), 0.5725);
  assert.equal(parseBeliefPercent('1'), 0.01);
  assert.equal(parseBeliefPercent('99'), 0.99);
  for (const text of ['', ' ', 'abc', 'Infinity', '0', '-1', '100']) {
    assert.equal(parseBeliefPercent(text), null);
  }
});

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
