import { Show } from 'solid-js';

// One row in a Followers / Following list: username link, accuracy + follower
// metadata, and a viewer-relative Follow / Unfollow button. Presentational only —
// the parent owns the async toggle and signal updates.
export default function NetworkUserRow(props) {
  const user = () => props.user || {};
  const isSelf = () => String(user().id) === String(props.viewerId || '');
  const accuracy = () => {
    const value = user().accuracy_percent;
    return value === null || value === undefined ? null : value;
  };

  const goToProfile = () => {
    if (user().id) {
      window.location.hash = `#user/${user().id}`;
    }
  };

  return (
    <div class="network-user-row">
      <button type="button" class="notification-link network-user-name" onClick={goToProfile}>
        {user().username || `user-${user().id}`}
      </button>

      <span class="network-user-meta">
        <Show when={accuracy() !== null}>
          <span class="network-user-accuracy" title="Forecast accuracy">{accuracy()}%</span>
        </Show>
        <span class="network-user-followers" title="Followers">
          {user().followers ?? 0} followers
        </span>
      </span>

      <Show when={props.canFollow && !isSelf()}>
        <button
          type="button"
          class={`network-user-follow ${user().is_following ? 'following' : 'not-following'}`}
          onClick={() => props.onToggleFollow(user())}
          disabled={props.busy}
        >
          {user().is_following ? 'Unfollow' : 'Follow'}
        </button>
      </Show>
    </div>
  );
}
