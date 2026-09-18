import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaForUrl, postLinkPreviews, safeWebUrl, textLinkParts } from './linkPreviews.js';

test('the reported legacy YouTube link gets a thumbnail and player without metadata', () => {
  const [preview] = postLinkPreviews({ content: 'Podcast discussion: https://youtu.be/ebac4NojRsI?si=22t3dAYr9z37I63k Will there be global cybersocialism?' });
  assert.equal(preview.image, 'https://i.ytimg.com/vi/ebac4NojRsI/hqdefault.jpg');
  assert.equal(preview.media.src, 'https://www.youtube-nocookie.com/embed/ebac4NojRsI?autoplay=1&playsinline=1');
});

test('YouTube URL variants retain timestamps without passing arbitrary parameters', () => {
  for (const url of [
    'https://youtube.com/watch?v=ebac4NojRsI&t=1h2m3s',
    'https://m.youtube.com/shorts/ebac4NojRsI?t=3723',
    'https://youtube.com/live/ebac4NojRsI#t=3723s',
    'https://www.youtube-nocookie.com/embed/ebac4NojRsI?start=3723'
  ]) assert.ok(mediaForUrl(url).src.endsWith('&start=3723'));
});

test('only exact provider hosts and valid identifiers get iframe players', () => {
  for (const url of ['https://youtube.com.evil.test/watch?v=ebac4NojRsI', 'https://evilyoutube.com/watch?v=ebac4NojRsI', 'https://youtu.be/invalid', 'https://youtube.com/playlist?list=abc', 'https://vimeo.com/not-a-video']) {
    assert.equal(mediaForUrl(url), null);
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@youtube.com/watch?v=ebac4NojRsI']) assert.equal(safeWebUrl(url), null);
});

test('Vimeo privacy hashes and direct media URLs are retained', () => {
  assert.equal(mediaForUrl('https://vimeo.com/12345/abc123').src, 'https://player.vimeo.com/video/12345?autoplay=1&h=abc123');
  assert.equal(mediaForUrl('https://player.vimeo.com/video/12345?h=abc123').src, 'https://player.vimeo.com/video/12345?autoplay=1&h=abc123');
  assert.equal(mediaForUrl('https://example.com/video.MP4?token=abc').kind, 'video');
  assert.equal(mediaForUrl('https://example.com/podcast.mp3').kind, 'audio');
});

test('link extraction preserves text and excludes Markdown and sentence punctuation', () => {
  const content = 'Podcast [watch](https://youtu.be/ebac4NojRsI). See https://example.com/wiki/Test_(topic), then https://example.com/?a=1&amp;b=2';
  const parts = textLinkParts(content);
  assert.equal(parts.map((part) => part.text).join(''), content);
  assert.deepEqual(parts.filter((part) => part.url).map((part) => part.url), [
    'https://youtu.be/ebac4NojRsI', 'https://example.com/wiki/Test_(topic)', 'https://example.com/?a=1&b=2'
  ]);
});

test('cards deduplicate links and use metadata only for the matching URL', () => {
  const cards = postLinkPreviews({ content: 'https://example.com/story https://example.com/story https://other.test/',
    link_meta_url: 'https://example.com/story', link_meta_title: 'Article title', link_meta_description: 'Description', link_meta_image_url: 'javascript:alert(1)' });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, 'Article title');
  assert.equal(cards[0].image, null);
  assert.equal(cards[1].title, 'other.test');
  assert.equal(cards[1].description, '');
  assert.deepEqual(postLinkPreviews({ content: 'No links', link_meta_url: 'https://old.test/' }), []);
});
