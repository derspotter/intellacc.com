/**
 * "Propose market" from a post.
 *
 * Any logged-in user can turn a post into a market question. We reuse the
 * submission form's own drafts (lib/persistedState keys) as the hand-off: the
 * form is pre-filled from the post, remembers which post it came from, and
 * the backend links post ↔ market once the question is approved.
 */
import { jsonStorage, draftKey } from './persistedState.js';

export const TITLE_MAX = 255;

const collapse = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** Strip bare URLs: a market title should be the claim, not the link. */
const withoutUrls = (text) => collapse(String(text || '').replace(/https?:\/\/\S+/gi, ' '));

const trimToMax = (text, max) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
};

/**
 * Title: the first sentence that reads like a question, else the first
 * sentence, capped at TITLE_MAX. Details: the whole post plus attribution.
 */
export const prefillFromPost = (post) => {
  const raw = String(post?.content || '');
  // Line breaks end a sentence too: a bare link line must not fuse with the
  // question that follows it.
  const sentences = raw
    .split(/\n+/)
    .flatMap((line) => withoutUrls(line).split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const question = sentences.find((s) => s.endsWith('?'));
  const title = trimToMax(question || sentences[0] || '', TITLE_MAX);
  const author = post?.username ? `@${post.username}` : 'a post';
  const details = `${collapse(raw)}\n\nProposed from ${author}'s post.`.trim();
  return { title, details };
};

/** Where the submission form lives. The Terminal skin has no such form, so
 *  callers there pass `{ viaVanSkin: true }` to open it in the Van skin. */
export const SUBMIT_HASH = 'predictions/submit';

export const proposeMarketFromPost = (post, userId, { viaVanSkin = false } = {}) => {
  if (!post?.id) return false;
  const { title, details } = prefillFromPost(post);
  const key = (name) => draftKey(`market-question:${name}`, userId);
  jsonStorage.set(key('title'), title);
  jsonStorage.set(key('details'), details);
  jsonStorage.set(key('sourcePostId'), Number(post.id));
  if (viaVanSkin) {
    window.location.href = `/?skin=van#${SUBMIT_HASH}`;
  } else {
    window.location.hash = SUBMIT_HASH;
  }
  return true;
};
