// Dev-only visual-regression harness: renders PostItem in isolation with fixed
// fixtures so the feed component can be screenshotted deterministically.
import { For } from 'solid-js';
import PostItem from '../components/posts/PostItem';
import { postItemFixtures } from './postItemFixtures';

const noop = () => {};

export default function Harness() {
  return (
    <section class="home-page" data-harness="postitem">
      <section class="posts-list">
        <For each={postItemFixtures}>
          {(post) => <PostItem post={post} onPostUpdate={noop} onPostDelete={noop} />}
        </For>
      </section>
    </section>
  );
}
