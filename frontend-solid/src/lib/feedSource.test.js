import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedSourceLabel } from './feedSource.js';

test('followed posts and own posts carry no explanation', () => {
  assert.equal(feedSourceLabel('following'), null);
});

test('the blended sources each get a short label', () => {
  assert.equal(feedSourceLabel('topic_market'), 'Market in your topics');
  assert.equal(feedSourceLabel('topic_user'), 'Shares your topics');
  assert.equal(feedSourceLabel('global'), 'Popular on Intellacc');
});

test('unknown or missing sources are silent, never "undefined"', () => {
  assert.equal(feedSourceLabel(undefined), null);
  assert.equal(feedSourceLabel(null), null);
  assert.equal(feedSourceLabel('something_new'), null);
});
