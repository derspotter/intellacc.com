import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonStorage, draftKey } from './persistedState.js';

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
};

test('get returns the fallback when nothing is stored', () => {
  const store = createJsonStorage(memoryStorage());
  assert.equal(store.get('filter', 'open'), 'open');
});

test('set then get round-trips objects and primitives', () => {
  const store = createJsonStorage(memoryStorage());
  store.set('draft', { content: 'hi', market: { id: 3 } });
  assert.deepEqual(store.get('draft', null), { content: 'hi', market: { id: 3 } });
  store.set('filter', 'resolved');
  assert.equal(store.get('filter', 'open'), 'resolved');
});

test('remove clears the key so the fallback applies again', () => {
  const store = createJsonStorage(memoryStorage());
  store.set('draft', 'x');
  store.remove('draft');
  assert.equal(store.get('draft', 'fallback'), 'fallback');
});

test('corrupt JSON and a throwing storage both yield the fallback instead of an exception', () => {
  const raw = memoryStorage();
  raw.setItem('bad', '{not json');
  const store = createJsonStorage(raw);
  assert.equal(store.get('bad', 'fallback'), 'fallback');

  const broken = createJsonStorage({
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  });
  assert.equal(broken.get('k', 'fallback'), 'fallback');
  assert.doesNotThrow(() => broken.set('k', 1));
  assert.doesNotThrow(() => broken.remove('k'));
});

test('a null storage (SSR / blocked) behaves like an empty one', () => {
  const store = createJsonStorage(null);
  assert.equal(store.get('k', 'fallback'), 'fallback');
  assert.doesNotThrow(() => store.set('k', 1));
});

test('draftKey scopes drafts per user and context', () => {
  assert.equal(draftKey('post', 42), 'draft:42:post');
  assert.equal(draftKey('group-chat:btc', 42), 'draft:42:group-chat:btc');
  assert.equal(draftKey('post', null), 'draft:anon:post');
});
