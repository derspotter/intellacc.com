import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefillFromPost, TITLE_MAX } from './proposeFromPost.js';

test('the title is the first question in the post, without the link', () => {
  const post = {
    username: 'philipp',
    content: 'Podcast discussion on Cybersocialism (in German): https://youtu.be/abc\n\nWill there be global cybersocialism before 01/01/2027? Maybe we should make a prediction market about it.'
  };
  const { title, details } = prefillFromPost(post);
  assert.equal(title, 'Will there be global cybersocialism before 01/01/2027?');
  assert.match(details, /^Podcast discussion on Cybersocialism/);
  assert.match(details, /Proposed from @philipp's post\.$/);
});

test('falls back to the first sentence when the post asks nothing', () => {
  const { title } = prefillFromPost({ content: 'MrBeast will not win the 2028 nomination! Mark my words.' });
  assert.equal(title, 'MrBeast will not win the 2028 nomination!');
});

test('long titles are cut at a word boundary under the column limit', () => {
  const { title } = prefillFromPost({ content: 'word '.repeat(120) + 'end' });
  assert.ok(title.length <= TITLE_MAX, `got ${title.length}`);
  assert.ok(title.endsWith('…'));
  assert.ok(!title.includes('  '));
});

test('empty or missing content yields empty title and attribution only', () => {
  const { title, details } = prefillFromPost({ content: '', username: 'x' });
  assert.equal(title, '');
  assert.equal(details, "Proposed from @x's post.");
  assert.equal(prefillFromPost(null).title, '');
});
