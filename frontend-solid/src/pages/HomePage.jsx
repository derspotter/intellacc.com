import { createSignal, createMemo, onMount, Show } from 'solid-js';
import { api, getFeedPage, getPostsPage, getPostsPayloadItems, getPostsPaging, getFeedWeights } from '../services/api';
import { rankPosts } from '../lib/feedRanking';
import CreatePostForm from '../components/posts/CreatePostForm';
import PostsList from '../components/posts/PostsList';
import WeeklyQuestionCard from '../components/predictions/WeeklyQuestionCard';
import { isAuthenticated } from '../services/auth';
import SearchPage from './SearchPage';

const DEFAULT_PAGE_LIMIT = 20;

const appendUniqueById = (existing, incoming) => {
  const map = new Map(existing.map((post) => [String(post.id), post]));
  for (const post of incoming) {
    map.set(String(post.id), post);
  }
  return Array.from(map.values());
};

export default function HomePage() {
  const [posts, setPosts] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [error, setError] = createSignal('');
  const [hasMore, setHasMore] = createSignal(true);
  const [nextCursor, setNextCursor] = createSignal(null);
  const [usingFeed, setUsingFeed] = createSignal(isAuthenticated());
  const [discoverMode, setDiscoverMode] = createSignal(false);
  const [feedWeights, setFeedWeights] = createSignal(null);

  // Reorder the loaded feed by the user's saved weight mix. rankPosts returns
  // the input order unchanged when no weights are saved (opt-in), so users who
  // never set a mix see the normal chronological feed. Ranking the full
  // accumulated list re-sorts on "Load more"; acceptable for v1 (the primary
  // requirement is reorder-on-open) — a rank-appended-page-only refinement is a
  // possible follow-up.
  const rankedPosts = createMemo(() => rankPosts(posts(), feedWeights()));

  const loadPosts = async ({ reset = true } = {}) => {
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    try {
      setError('');
      const cursor = reset ? null : nextCursor();
      const pageFn = usingFeed() ? getFeedPage : getPostsPage;
      const response = await pageFn({ cursor, limit: DEFAULT_PAGE_LIMIT });
      const normalized = getPostsPaging(response);
      const nextPosts = getPostsPayloadItems(normalized.items);

      // Empty following-feed on a reset load: fall back to the discover feed
      // (top predictors in the caller's topics) so the home page is never blank.
      if (reset && usingFeed() && nextPosts.length === 0) {
        try {
          const discover = await api.discover.feed();
          const discoverItems = getPostsPayloadItems(discover?.items);
          if (discoverItems.length > 0) {
            setDiscoverMode(true);
            setPosts(discoverItems);
            setHasMore(false);
            setNextCursor(null);
            return;
          }
        } catch (discoverErr) {
          console.error('Discover feed fallback failed:', discoverErr);
        }
      }

      if (reset) {
        setDiscoverMode(false);
        setPosts(nextPosts);
      } else {
        setPosts((current) => appendUniqueById(current, nextPosts));
      }

      setHasMore(Boolean(normalized.hasMore));
      setNextCursor(normalized.nextCursor || null);

      if (!response && cursor) {
        setHasMore(false);
        setNextCursor(null);
      }
    } catch (err) {
      const bodyMessage = err?.message || 'Failed to load posts.';
      const likelyAuthIssue = bodyMessage.includes('401') || bodyMessage.includes('403');
      if (usingFeed() && likelyAuthIssue && reset) {
        setUsingFeed(false);
        setError('Feed endpoint requires auth; switching to public posts.');
        await loadPosts({ reset: true });
      } else {
        setError(bodyMessage);
      }
      if (reset) {
        setPosts([]);
      }
      setHasMore(false);
      setNextCursor(null);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const loadMore = async () => {
    if (loadingMore() || loading() || !hasMore()) return;
    await loadPosts({ reset: false });
  };

  const handleFollowed = async () => {
    setDiscoverMode(false);
    await loadPosts({ reset: true });
  };

  const handlePostCreated = (post) => {
    if (!post) return;
    setPosts((current) => {
      const filtered = current.filter((item) => String(item.id) !== String(post.id));
      return [post, ...filtered];
    });
  };

  const updatePost = (postId, patch) => {
    setPosts((current) =>
      current.map((post) => {
        if (String(post.id) !== String(postId)) {
          return post;
        }
        return { ...post, ...(typeof patch === 'function' ? patch(post) : patch) };
      })
    );
  };

  const removePost = (postId) => {
    setPosts((current) => current.filter((post) => String(post.id) !== String(postId)));
  };

  onMount(() => {
    loadPosts({ reset: true });
    getFeedWeights()
      .then((res) => { if (res && res.weights) setFeedWeights(res.weights); })
      .catch(() => { /* no saved mix -> chronological feed */ });
  });

  return (
    <section class="home-page">
      <Show when={!isAuthenticated()}>
        <div class="login-notice">
          <p>Sign in to create posts and see personalized content.</p>
          <button type="button" onClick={() => (window.location.hash = 'login')}>
            Log in
          </button>
        </div>
      </Show>
      
      <div style={{ "margin-bottom": "2rem" }}>
        <SearchPage showHeader={false} showHints={false} />
      </div>

      <Show when={isAuthenticated()}>
        <WeeklyQuestionCard />
        <CreatePostForm onCreated={handlePostCreated} />
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={loading()}>
        <p>Loading posts…</p>
      </Show>
      <Show when={!loading()}>
        <Show when={discoverMode()}>
          <p class="discover-notice">Showing top predictors in your topics — follow people to make this feed yours.</p>
        </Show>
        <PostsList
          posts={rankedPosts}
          onPostUpdate={updatePost}
          onPostDelete={removePost}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={hasMore}
          discoverMode={discoverMode}
          onFollowed={handleFollowed}
        />
        <div class="form-actions">
          <Show when={hasMore() && posts().length > 0}>
            <button class="post-action" onClick={loadMore} disabled={loadingMore()}>
              {loadingMore() ? 'Loading…' : 'Load more'}
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}
