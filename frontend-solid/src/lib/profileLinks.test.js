import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userHash, isValidUserId } from './profileLinks.js';

test('isValidUserId accepts positive integers only', () => {
  assert.equal(isValidUserId(7), true);
  assert.equal(isValidUserId('7'), true);
  assert.equal(isValidUserId(0), false);
  assert.equal(isValidUserId(-1), false);
  assert.equal(isValidUserId('abc'), false);
  assert.equal(isValidUserId(undefined), false);
  assert.equal(isValidUserId(null), false);
  assert.equal(isValidUserId('undefined'), false);
});

test('userHash builds a profile hash for a valid id and nothing otherwise', () => {
  assert.equal(userHash(7), '#user/7');
  assert.equal(userHash('12'), '#user/12');
  assert.equal(userHash(undefined), null);
  assert.equal(userHash('NaN'), null);
});
