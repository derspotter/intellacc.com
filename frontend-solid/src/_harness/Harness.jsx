// Dev-only visual-regression harness: renders PostItem in isolation with fixed
// fixtures so the feed component can be screenshotted deterministically.
import { createSignal } from 'solid-js';
import PostsList from '../components/posts/PostsList';
import { postItemFixtures } from './postItemFixtures';

const noop = () => {};

export default function Harness() {
  const [posts, setPosts] = createSignal(postItemFixtures);
  const updatePost = (id, patch) => setPosts((current) => current.map((post) =>
    post.id === id ? { ...post, ...patch } : post
  ));
  return (
    // Opaque white backdrop above the app's decorative fixed SVG (z-index -1), so
    // screenshots show only the component, not background bleed-through.
    <section
      class="home-page"
      data-harness="postitem"
      style={{ position: 'relative', 'z-index': '1', background: '#fff', 'min-height': '100vh', padding: '1rem' }}
    >
      <PostsList
        posts={posts}
        loading={() => false}
        loadingMore={() => false}
        onPostUpdate={updatePost}
        onPostDelete={noop}
      />
    </section>
  );
}
