import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPositions, summarizeHoldings, positionStatus } from './positionGroups.js';

const row = (over = {}) => ({
  event_id: 1, event_title: 'Will X happen?', closing_date: '2027-01-01', market_prob: 0.6,
  event_type: 'binary', position_kind: 'open', yes_shares: 0, no_shares: 0, outcome_label: null,
  outcome_shares: 0, resolved_at: null, resolution_outcome_label: null, hidden_at: null, ...over
});

test('one group per market, binary YES/NO shares collected as outcomes', () => {
  const g = groupPositions([row({ yes_shares: 12 }), row({ event_id: 2, event_title: 'Y', no_shares: 3 })]);
  assert.equal(g.all.length, 2);
  assert.deepEqual(g.byId.get('1').outcomes, [{ label: 'YES', shares: 12 }]);
  assert.deepEqual(g.byId.get('2').outcomes, [{ label: 'NO', shares: 3 }]);
});

test('open markets sort by closing date, resolved ones after them newest first', () => {
  const g = groupPositions([
    row({ event_id: 1, closing_date: '2027-06-01', yes_shares: 1 }),
    row({ event_id: 2, closing_date: '2027-01-01', yes_shares: 1 }),
    row({ event_id: 3, position_kind: 'resolved', resolved_at: '2026-01-01', resolution_outcome_label: 'YES', yes_shares: 1 }),
    row({ event_id: 4, position_kind: 'resolved', resolved_at: '2026-05-01', resolution_outcome_label: 'NO', yes_shares: 1 }),
  ]);
  assert.deepEqual(g.open.map((x) => x.event.id), [2, 1]);
  assert.deepEqual(g.resolved.map((x) => x.event.id), [4, 3]);
  assert.deepEqual(g.all.map((x) => x.event.id), [2, 1, 4, 3]);
});

test('numeric markets aggregate bins instead of listing outcomes', () => {
  const g = groupPositions([
    row({ event_type: 'numeric', outcome_label: 'bin 1', outcome_shares: 2 }),
    row({ event_type: 'numeric', outcome_label: 'bin 2', outcome_shares: 3.5 }),
  ]);
  const grp = g.byId.get('1');
  assert.equal(grp.numericBins, 2);
  assert.equal(grp.numericShares, 5.5);
  assert.deepEqual(grp.outcomes, []);
});

test('summarizeHoldings renders a compact human line', () => {
  const g = groupPositions([row({ yes_shares: 12, no_shares: 3 })]);
  assert.equal(summarizeHoldings(g.byId.get('1')), 'YES ×12.0 · NO ×3.0');
  const n = groupPositions([row({ event_type: 'numeric', outcome_label: 'b', outcome_shares: 4 })]);
  assert.equal(summarizeHoldings(n.byId.get('1')), 'Distribution · 1 bin · 4.0 sh');
});

test('positionStatus is the resolution label when resolved, else Open', () => {
  const g = groupPositions([
    row({ event_id: 1, yes_shares: 1 }),
    row({ event_id: 2, position_kind: 'resolved', resolution_outcome_label: 'YES', yes_shares: 1 }),
    row({ event_id: 3, position_kind: 'resolved', resolution_outcome_label: null, yes_shares: 1 }),
  ]);
  assert.equal(positionStatus(g.byId.get('1')), 'Open');
  assert.equal(positionStatus(g.byId.get('2')), 'YES');
  assert.equal(positionStatus(g.byId.get('3')), 'Resolved');
});

test('empty or malformed input yields empty groups', () => {
  assert.equal(groupPositions(null).all.length, 0);
  assert.equal(groupPositions({ items: [] }).all.length, 0);
});
