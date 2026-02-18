import { createSignal, onMount, Show } from 'solid-js';
import { getFeedPage, getPostsPage, getPostsPayloadItems, getPostsPaging } from '../services/api';
import CreatePostForm from '../components/posts/CreatePostForm';
import PostsList from '../components/posts/PostsList';
import { isAuthenticated } from '../services/auth';

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

      if (reset) {
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
  });

  return (
    <section class="home-page">
      <h1>Home Feed (Solid Migration)</h1>
      <p>Feature slice: posts list + create-post parity baseline.</p>
      <Show when={isAuthenticated()}>
        <CreatePostForm onCreated={handlePostCreated} />
      </Show>
      <Show when={!isAuthenticated()}>
        <p class="muted">Sign in to post and use your personalized feed.</p>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={loading()}>
        <p>Loading posts…</p>
      </Show>
      <Show when={!loading()}>
        <PostsList
          posts={posts}
          onPostUpdate={updatePost}
          onPostDelete={removePost}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={hasMore}
        />
        <div class="load-more-row">
          <Show when={hasMore() && posts().length > 0}>
            <button onClick={loadMore} disabled={loadingMore()}>
              {loadingMore() ? 'Loading…' : 'Load more'}
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}
