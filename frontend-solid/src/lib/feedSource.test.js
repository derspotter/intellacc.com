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

import { markAuthorFollowed } from './feedSource.js';

test('markAuthorFollowed relabels only that author\'s rows, without refetching', () => {
  const posts = [
    { id: 1, user_id: 7, feed_source: 'topic_user' },
    { id: 2, user_id: 8, feed_source: 'topic_user' },
    { id: 3, user_id: 7, feed_source: 'global' },
    { id: 4, user_id: 9, feed_source: 'following' },
  ];
  const out = markAuthorFollowed(posts, 7);
  assert.deepEqual(out.map((p) => p.feed_source), ['following', 'topic_user', 'following', 'following']);
  assert.notEqual(out, posts, 'returns a new array');
  assert.equal(out[1], posts[1], 'untouched rows keep identity');
  assert.equal(posts[0].feed_source, 'topic_user', 'input is not mutated');
});

test('markAuthorFollowed tolerates string ids and empty input', () => {
  assert.deepEqual(markAuthorFollowed([{ id: 1, user_id: '7', feed_source: 'global' }], 7)[0].feed_source, 'following');
  assert.deepEqual(markAuthorFollowed(null, 7), []);
});
