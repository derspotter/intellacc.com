import { createSignal, onMount, For, Show } from 'solid-js';
import { getPosts } from '../services/api';

const resolvePosts = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.posts)) return payload.posts;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
};

export default function HomePage() {
  const [posts, setPosts] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(async () => {
    setLoading(true);
    try {
      const data = await getPosts(20);
      setPosts(resolvePosts(data));
    } catch (err) {
      setError(err?.message || 'Failed to load posts.');
    } finally {
      setLoading(false);
    }
  });

  return (
    <section class="home-page">
      <h1>Home Feed (Solid Migration)</h1>
      <p>First migration slice: parity baseline shell and feed load.</p>
      <Show when={loading()}>
        <p>Loading posts…</p>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <Show when={!loading() && !error()}>
        <div class="feed-list">
          <For each={posts()}>
            {(post) => (
              <article class="feed-item">
                <h2>{post.title || `Post #${post.id}`}</h2>
                <p>{post.content || 'No post content available.'}</p>
                <p class="meta">by {post.username || `user ${post.user_id || 'unknown'}`}</p>
              </article>
            )}
          </For>
          <Show when={posts().length === 0}>
            <p class="empty-feed">No posts yet.</p>
          </Show>
        </div>
      </Show>
    </section>
  );
}
