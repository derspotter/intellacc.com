// Dev-only visual-regression harness: renders PostItem in isolation with fixed
// fixtures so the feed component can be screenshotted deterministically.
import { For } from 'solid-js';
import PostItem from '../components/posts/PostItem';
import { postItemFixtures } from './postItemFixtures';

const noop = () => {};

export default function Harness() {
  return (
    // Opaque white backdrop above the app's decorative fixed SVG (z-index -1), so
    // screenshots show only the component, not background bleed-through.
    <section
      class="home-page"
      data-harness="postitem"
      style={{ position: 'relative', 'z-index': '1', background: '#fff', 'min-height': '100vh', padding: '1rem' }}
    >
      <section class="posts-list">
        <For each={postItemFixtures}>
          {(post) => <PostItem post={post} onPostUpdate={noop} onPostDelete={noop} />}
        </For>
      </section>
    </section>
  );
}
