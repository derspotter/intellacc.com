import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmCore, CONFIRM_RESET_MS } from './confirmTimer.js';

// Minimal signal-like store: set() accepts a value or an updater function,
// mirroring Solid's setter semantics.
function makeStore(initial = null) {
  let state = initial;
  return {
    get: () => state,
    set: (v) => { state = typeof v === 'function' ? v(state) : v; return state; }
  };
}

// Manual fake timer scheduler.
function makeScheduler() {
  let nextId = 1;
  const pending = new Map();
  return {
    schedule: (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    cancel: (id) => { pending.delete(id); },
    fire: (id) => { const t = pending.get(id); pending.delete(id); if (t) t.fn(); },
    fireAll: () => { for (const id of [...pending.keys()]) { const t = pending.get(id); pending.delete(id); t.fn(); } },
    count: () => pending.size
  };
}

function setup() {
  const store = makeStore();
  const timers = makeScheduler();
  const core = createConfirmCore({
    get: store.get,
    set: store.set,
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  return { store, timers, core };
}

test('default reset delay is 4000ms', () => {
  assert.equal(CONFIRM_RESET_MS, 4000);
});

test('first confirm() arms and returns false; second returns true and disarms', () => {
  const { store, timers, core } = setup();
  assert.equal(core.confirm(7), false);
  assert.equal(store.get(), 7);
  assert.equal(core.isArmed(7), true);
  assert.equal(timers.count(), 1);

  assert.equal(core.confirm(7), true);
  assert.equal(store.get(), null);
  assert.equal(core.isArmed(7), false);
  assert.equal(timers.count(), 0, 'confirming clears the pending reset timer');
});

test('auto-reset fires after the delay and disarms', () => {
  const { store, timers, core } = setup();
  core.confirm(3);
  timers.fireAll();
  assert.equal(store.get(), null);
  assert.equal(core.isArmed(3), false);
});

test('stale timeout does not clobber a newer armed id', () => {
  const { store, timers, core } = setup();
  core.confirm(1);
  // Arming a different id cancels the old timer...
  core.confirm(2);
  assert.equal(store.get(), 2);
  assert.equal(timers.count(), 1, 'old timer was cancelled, only one pending');
  // ...and even if a stale callback somehow ran, the guard keeps id 2 armed.
  timers.fireAll();
  assert.equal(store.get(), null);
});

test('arming a second id replaces the first (single armed id at a time)', () => {
  const { store, core } = setup();
  assert.equal(core.confirm('a'), false);
  assert.equal(core.confirm('b'), false, 'switching targets re-arms instead of confirming');
  assert.equal(store.get(), 'b');
  assert.equal(core.isArmed('a'), false);
  assert.equal(core.isArmed('b'), true);
});

test('disarm(id) resets only when that id is armed', () => {
  const { store, timers, core } = setup();
  core.confirm(5);
  core.disarm(9); // different id: no-op
  assert.equal(store.get(), 5);
  core.disarm(5); // armed id: reset + cancel timer
  assert.equal(store.get(), null);
  assert.equal(timers.count(), 0);
});

test('dispose() cancels the pending timer without touching state', () => {
  const { store, timers, core } = setup();
  core.confirm(4);
  core.dispose();
  assert.equal(timers.count(), 0, 'no timer can fire after dispose');
  // State is left as-is; the owning component is unmounting anyway.
  assert.equal(store.get(), 4);
});

test('confirm after auto-reset requires arming again', () => {
  const { timers, core } = setup();
  core.confirm(1);
  timers.fireAll();
  assert.equal(core.confirm(1), false, 'after reset the next click re-arms');
});
