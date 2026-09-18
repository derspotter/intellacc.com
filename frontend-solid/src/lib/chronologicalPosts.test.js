import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chronologicalPosts } from './chronologicalPosts.js';

test('posts are newest first regardless of author or engagement', () => {
  const posts = [
    { id: 1, user_id: 42, created_at: '2026-01-01T12:00:00Z', like_count: 1000, author_accuracy: 100 },
    { id: 3, user_id: 7, created_at: '2026-01-03T12:00:00Z', like_count: 0 },
    { id: 2, user_id: 42, created_at: '2026-01-02T12:00:00Z', view_count: 5000 }
  ];
  assert.deepEqual(chronologicalPosts(posts).map(p => p.id), [3, 2, 1]);
  assert.deepEqual(posts.map(p => p.id), [1, 3, 2]);
});

test('equal timestamps use descending post id, as the API does', () => {
  const posts = [2, 10, 3].map(id => ({ id: String(id), created_at: '2026-01-01T12:00:00Z' }));
  assert.deepEqual(chronologicalPosts(posts).map(p => p.id), ['10', '3', '2']);
});

test('handles empty feeds and puts missing dates last', () => {
  assert.deepEqual(chronologicalPosts(null), []);
  assert.deepEqual(chronologicalPosts([]), []);
  assert.deepEqual(chronologicalPosts([{ id: 10 }, { id: 1, created_at: '2026-01-01' }]).map(p => p.id), [1, 10]);
});
