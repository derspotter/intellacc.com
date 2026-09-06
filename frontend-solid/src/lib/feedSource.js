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

/**
 * After a follow, relabel that author's rows as "following" in place. A
 * follow changes exactly one fact about the loaded feed, so no refetch:
 * refetching reorders rows, drops scroll position and can even flip the
 * global fall-through decision mid-session. Untouched rows keep identity so
 * Solid does not re-render them.
 */
export const markAuthorFollowed = (posts, userId) => {
  const target = String(userId);
  return (Array.isArray(posts) ? posts : []).map((post) =>
    String(post?.user_id) === target && post.feed_source !== 'following'
      ? { ...post, feed_source: 'following' }
      : post
  );
};
