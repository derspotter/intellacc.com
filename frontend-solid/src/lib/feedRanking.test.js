import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redistribute, rankPosts, KEYS } from './feedRanking.js';

const sum = (w) => w.accuracy + w.followers + w.likes + w.views;
const noLocks = { accuracy: false, followers: false, likes: false, views: false };

test('redistribute splits freed budget equally among equal others', () => {
  const out = redistribute({ accuracy: 25, followers: 25, likes: 25, views: 25 }, noLocks, 'accuracy', 40);
  assert.equal(out.accuracy, 40);
  assert.equal(sum(out), 100);
  assert.deepEqual([out.followers, out.likes, out.views], [20, 20, 20]);
});

test('redistribute keeps locked sliders fixed', () => {
  const locks = { ...noLocks, followers: true };
  const out = redistribute({ accuracy: 25, followers: 25, likes: 25, views: 25 }, locks, 'accuracy', 50);
  assert.equal(out.followers, 25);
  assert.equal(out.accuracy, 50);
  assert.equal(out.likes + out.views, 25);
  assert.equal(sum(out), 100);
});

test('redistribute is proportional to current values', () => {
  const out = redistribute({ accuracy: 40, followers: 30, likes: 20, views: 10 }, noLocks, 'accuracy', 60);
  assert.equal(out.accuracy, 60);
  assert.equal(sum(out), 100);
  assert.ok(out.followers > out.likes && out.likes > out.views);
});

test('redistribute clamps the dragged slider to 100 minus locked', () => {
  const locks = { ...noLocks, followers: true, likes: true, views: true };
  const out = redistribute({ accuracy: 25, followers: 25, likes: 25, views: 25 }, locks, 'accuracy', 90);
  assert.equal(out.accuracy, 25);
  assert.equal(sum(out), 100);
});

test('redistribute splits equally when all others are zero', () => {
  const out = redistribute({ accuracy: 100, followers: 0, likes: 0, views: 0 }, noLocks, 'accuracy', 40);
  assert.deepEqual([out.followers, out.likes, out.views], [20, 20, 20]);
  assert.equal(sum(out), 100);
});

const mkPost = (id, accuracy, followers, likes, views) =>
  ({ id, author_accuracy: accuracy, author_followers: followers, like_count: likes, view_count: views });

test('rankPosts returns input unchanged when weights are null', () => {
  const posts = [mkPost(1, 10, 0, 0, 0), mkPost(2, 90, 0, 0, 0)];
  assert.deepEqual(rankPosts(posts, null).map((p) => p.id), [1, 2]);
});

test('rankPosts ranks by accuracy when accuracy is fully weighted', () => {
  const posts = [mkPost(1, 10, 5, 5, 5), mkPost(2, 90, 5, 5, 5), mkPost(3, 50, 5, 5, 5)];
  const out = rankPosts(posts, { accuracy: 100, followers: 0, likes: 0, views: 0 });
  assert.deepEqual(out.map((p) => p.id), [2, 3, 1]);
});

test('rankPosts ranks by likes when likes is fully weighted', () => {
  const posts = [mkPost(1, 0, 0, 2, 0), mkPost(2, 0, 0, 100, 0), mkPost(3, 0, 0, 10, 0)];
  const out = rankPosts(posts, { accuracy: 0, followers: 0, likes: 100, views: 0 });
  assert.deepEqual(out.map((p) => p.id), [2, 3, 1]);
});

test('rankPosts is a stable tie-break on input order', () => {
  const posts = [mkPost(1, 50, 0, 0, 0), mkPost(2, 50, 0, 0, 0)];
  const out = rankPosts(posts, { accuracy: 100, followers: 0, likes: 0, views: 0 });
  assert.deepEqual(out.map((p) => p.id), [1, 2]);
});

test('rankPosts handles empty input', () => {
  assert.deepEqual(rankPosts([], { accuracy: 25, followers: 25, likes: 25, views: 25 }), []);
});
