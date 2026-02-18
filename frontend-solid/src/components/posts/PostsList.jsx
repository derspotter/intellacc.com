import { For, Show } from 'solid-js';
import PostItem from './PostItem';

export default function PostsList(props) {
  return (
    <section class="posts-list">
      <For each={props.posts()}>
        {(post) => <PostItem post={post} />}
      </For>
      <Show when={props.loadingMore()}>
        <p class="loading-inline">Loading more posts…</p>
      </Show>
      <Show when={props.hasMore() === false && props.posts().length > 0}>
        <p class="end-of-feed">End of feed</p>
      </Show>
      <Show when={props.posts().length === 0 && !props.loading()}>
        <p class="empty-feed">No posts yet.</p>
      </Show>
    </section>
  );
}
