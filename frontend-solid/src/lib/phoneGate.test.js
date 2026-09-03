import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsPhoneVerification, PHONE_TIER } from './phoneGate.js';

test('phone tier is 2 and lower tiers need verification', () => {
  assert.equal(PHONE_TIER, 2);
  assert.equal(needsPhoneVerification({ current_tier: 0 }), true);
  assert.equal(needsPhoneVerification({ current_tier: 1 }), true);
  assert.equal(needsPhoneVerification({ current_tier: 2 }), false);
  assert.equal(needsPhoneVerification({ current_tier: 3 }), false);
});

test('unknown status never shows the gate', () => {
  assert.equal(needsPhoneVerification(null), false);
  assert.equal(needsPhoneVerification(undefined), false);
  assert.equal(needsPhoneVerification({}), true, 'missing tier counts as 0 (unverified)');
});
