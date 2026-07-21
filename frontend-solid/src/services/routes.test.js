import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, NOT_FOUND_ROUTE, AUTH_ROUTES, normalizeHashPath, sanitizeRoute, parseHashRoute } from './routes.js';

test('normalizeHashPath strips hash, slashes, and query', () => {
  assert.equal(normalizeHashPath('#home'), 'home');
  assert.equal(normalizeHashPath('#/predictions/'), 'predictions');
  assert.equal(normalizeHashPath('#settings?tab=vault'), 'settings');
  assert.equal(normalizeHashPath('#user/alice'), 'user/alice');
});

test('normalizeHashPath falls back to home on empty or query-only input', () => {
  assert.equal(normalizeHashPath(''), 'home');
  assert.equal(normalizeHashPath(null), 'home');
  assert.equal(normalizeHashPath('#'), 'home');
  assert.equal(normalizeHashPath('#?foo=1'), 'home');
  assert.equal(normalizeHashPath('#///'), 'home');
});

test('sanitizeRoute maps known routes and rejects unknown ones', () => {
  assert.equal(sanitizeRoute('#home'), 'home');
  assert.equal(sanitizeRoute('#group/rust-fans'), 'group');
  assert.equal(sanitizeRoute('#no-such-page'), NOT_FOUND_ROUTE);
  assert.equal(sanitizeRoute('#NOTfound/123'), NOT_FOUND_ROUTE);
});

test('parseHashRoute splits route and param', () => {
  assert.deepEqual(parseHashRoute('#user/alice'), { page: 'user', param: 'alice' });
  assert.deepEqual(parseHashRoute('#predictions/42'), { page: 'predictions', param: '42' });
  assert.deepEqual(parseHashRoute('#settings'), { page: 'settings', param: null });
});

test('parseHashRoute rejects bare #user and unknown routes', () => {
  assert.deepEqual(parseHashRoute('#user'), { page: NOT_FOUND_ROUTE, param: null });
  assert.equal(parseHashRoute('#bogus/thing').page, NOT_FOUND_ROUTE);
});

test('auth routes are all registered routes', () => {
  for (const route of AUTH_ROUTES) {
    assert.equal(ROUTES[route], route);
  }
});
