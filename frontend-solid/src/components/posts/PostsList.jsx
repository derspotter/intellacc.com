import { createEffect, For, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import PostItem from './PostItem';

export default function PostsList(props) {
  // Keep cards mounted when a post's counts or content change.
  const [state, setState] = createStore({ posts: [] });
  createEffect(() => setState('posts', reconcile(props.posts())));

  return (
    <section class="posts-list" data-primary-list>
      <For each={state.posts}>
        {(post) => (
          <PostItem
            post={post}
            onPostUpdate={props.onPostUpdate}
            onPostDelete={props.onPostDelete}
            onFollowed={props.onFollowed}
          />
        )}
      </For>
      <Show when={props.loadingMore()}>
        <p class="loading-inline">Loading more posts…</p>
      </Show>
      <Show when={props.posts().length === 0 && !props.loading()}>
        <p class="empty-feed">No posts yet.</p>
      </Show>
    </section>
  );
}
