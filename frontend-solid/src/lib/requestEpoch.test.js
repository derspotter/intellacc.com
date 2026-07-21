import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEpochGuard } from './requestEpoch.js';

test('begin returns a token that is current until superseded', () => {
  const guard = createEpochGuard();
  const token = guard.begin();
  assert.equal(guard.isCurrent(token), true);
});

test('stale token is rejected after a new begin', () => {
  const guard = createEpochGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});

test('current captures the active token without starting a new request', () => {
  const guard = createEpochGuard();
  const token = guard.begin();
  const snapshot = guard.current();
  assert.equal(snapshot, token);
  assert.equal(guard.isCurrent(snapshot), true);
  guard.begin();
  assert.equal(guard.isCurrent(snapshot), false);
});

test('invalidate makes every outstanding token stale', () => {
  const guard = createEpochGuard();
  const token = guard.begin();
  guard.invalidate();
  assert.equal(guard.isCurrent(token), false);
  assert.equal(guard.isCurrent(guard.current()), true);
});

test('independent guards do not interfere', () => {
  const a = createEpochGuard();
  const b = createEpochGuard();
  const tokenA = a.begin();
  b.begin();
  b.begin();
  assert.equal(a.isCurrent(tokenA), true);
  assert.equal(b.isCurrent(tokenA), false); // tokens are per-guard, not global
});

test('typical async race: only the latest request applies its result', async () => {
  const guard = createEpochGuard();
  const applied = [];
  const request = async (name, delay) => {
    const token = guard.begin();
    await new Promise((r) => setTimeout(r, delay));
    if (!guard.isCurrent(token)) return;
    applied.push(name);
  };
  // Slow request starts first, fast request supersedes it.
  const slow = request('slow', 30);
  const fast = request('fast', 5);
  await Promise.all([slow, fast]);
  assert.deepEqual(applied, ['fast']);
});
