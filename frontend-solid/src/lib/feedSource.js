/**
 * "Why you see this" labels for blended-feed rows.
 *
 * The feed mixes people you follow, posts tied to markets in your topics,
 * posts by users who share your topics, and — while those are thin —
 * everyone. Rows you did not opt into by following say so, so the feed
 * never looks like it invented a follow.
 */
const LABELS = {
  topic_market: 'Market in your topics',
  topic_user: 'Shares your topics',
  global: 'Popular on Intellacc'
};

/** Label for a feed row, or null when the row needs no explanation. */
export const feedSourceLabel = (source) => LABELS[source] || null;

export const FEED_SOURCE_LABELS = LABELS;
