import {
  createEffect,
  createSignal,
  For,
  Show
} from 'solid-js';
import {
  createDirectMessage,
  followUser,
  getCurrentUser,
  getFollowers,
  getFollowing,
  getFollowingStatus,
  getUser,
  getUserReputation,
  unfollowUser,
  updateProfile
} from '../services/api';
import { getCurrentUserId, isAuthenticated } from '../services/auth';

const coerceUser = (user) => {
  if (!user || typeof user !== 'object') {
    return null;
  }

  return {
    id: user.id || user.userId,
    username: user.username || 'User',
    email: user.email || '',
    bio: user.bio || ''
  };
};

const normalizeId = (value) => {
  if (value == null) {
    return null;
  }
  const trimmed = String(value).trim();
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) ? String(parsed) : trimmed;
};

const normalizeReputation = (value = {}) => ({
  rank: value.rank || null,
  rep_points: Number(value.rep_points || value.points || 0),
  total_predictions: Number(value.total_predictions || 0)
});

const countFromResponse = (payload) => {
  if (Array.isArray(payload)) {
    return payload.length;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items.length;
  }
  if (Array.isArray(payload?.followers)) {
    return payload.followers.length;
  }
  return 0;
};

const extractNotifications = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  if (Array.isArray(payload?.users)) {
    return payload.users;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  return [];
};

export default function ProfilePage(props) {
  const [profile, setProfile] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const [followers, setFollowers] = createSignal([]);
  const [following, setFollowing] = createSignal([]);
  const [followingStatus, setFollowingStatus] = createSignal(false);

  const [reputation, setReputation] = createSignal(normalizeReputation({}));
  const [editing, setEditing] = createSignal(false);
  const [usernameInput, setUsernameInput] = createSignal('');
  const [bioInput, setBioInput] = createSignal('');
  const [savingProfile, setSavingProfile] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  const [actionMessage, setActionMessage] = createSignal('');
  const [messageUserId, setMessageUserId] = createSignal('');

  const targetUserId = () => normalizeId(props.userId?.() || props.userId || null);
  const isOwnProfile = () => {
    if (targetUserId()) {
      return String(getCurrentUserId() || '') === String(targetUserId());
    }
    return isAuthenticated();
  };
  const isEditable = () => isAuthenticated() && isOwnProfile() && !loading();

  const fetchProfile = async () => {
    const userId = targetUserId();
    if (!isAuthenticated() && !userId) {
      setError('Sign in to view your profile.');
      setProfile(null);
      return;
    }

    try {
      setLoading(true);
      setError('');
      const baseProfile = userId ? await getUser(userId) : await getCurrentUser();
      if (!baseProfile?.id) {
        setError('Profile data missing or invalid.');
        setProfile(null);
        return;
      }

      const normalizedProfile = coerceUser(baseProfile);
      setProfile(normalizedProfile);
      setUsernameInput(normalizedProfile.username);
      setBioInput(normalizedProfile.bio);

      const followerRows = await getFollowers(normalizedProfile.id);
      const followingRows = await getFollowing(normalizedProfile.id);
      const rep = await getUserReputation(normalizedProfile.id).catch(() => ({}));

      setFollowers(extractNotifications(followerRows));
      setFollowing(extractNotifications(followingRows));
      setReputation(normalizeReputation(rep));

      if (isAuthenticated() && !isOwnProfile()) {
        const status = await getFollowingStatus(normalizedProfile.id);
        setFollowingStatus(Boolean(status?.isFollowing));
      } else {
        setFollowingStatus(false);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load profile.');
      setProfile(null);
    } finally {
      setLoading(false);
    }
  };

  const handleProfileSave = async (event) => {
    event.preventDefault();
    if (!isEditable()) {
      return;
    }

    try {
      setSavingProfile(true);
      setActionError('');
      setActionMessage('');

      const payload = {};
      const username = usernameInput().trim();
      const bio = bioInput().trim();

      if (username) {
        payload.username = username;
      }
      if (bio) {
        payload.bio = bio;
      }

      const updated = await updateProfile(payload);
      const nextProfile = coerceUser(updated || { ...profile(), username, bio });
      setProfile(nextProfile);
      setEditing(false);
      setActionMessage('Profile updated.');
    } catch (err) {
      setActionError(err?.message || 'Failed to update profile.');
    } finally {
      setSavingProfile(false);
      setTimeout(() => setActionMessage(''), 1600);
    }
  };

  const toggleFollow = async () => {
    const currentProfile = profile();
    if (!currentProfile || isOwnProfile() || !isAuthenticated()) {
      return;
    }

    const userId = normalizeId(currentProfile.id);
    if (!userId) {
      return;
    }

    try {
      setActionError('');
      setActionMessage('');
      if (followingStatus()) {
        await unfollowUser(userId);
        setFollowingStatus(false);
        setFollowing((current) => current.filter((entry) => String(entry.id) !== String(userId)));
      } else {
        await followUser(userId);
        setFollowingStatus(true);
        setActionMessage('Following now.');
      }
    } catch (err) {
      setActionError(err?.message || 'Unable to update follow status.');
    } finally {
      setTimeout(() => setActionMessage(''), 1200);
    }
  };

  const handleMessage = async () => {
    const target = targetUserId();
    if (!isAuthenticated() || !target || isOwnProfile()) {
      return;
    }

    const parsed = Number.parseInt(String(target), 10);
    if (!Number.isInteger(parsed)) {
      setActionError('Invalid user id.');
      return;
    }

    try {
      setActionError('');
      setMessageUserId(String(parsed));
      const created = await createDirectMessage(parsed);
      setMessageUserId(`Created conversation ${created.groupId || ''}`.trim());
      setActionMessage(`Conversation opened: ${created.groupId}`);
    } catch (err) {
      setActionError(err?.message || 'Failed to create message thread.');
    } finally {
      setTimeout(() => setActionMessage(''), 1400);
    }
  };

  createEffect(() => {
    targetUserId();
    fetchProfile();
  });

  return (
    <section class="profile-page">
      <h1>{isOwnProfile() ? 'My Profile' : 'Profile'}</h1>

      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>

      <Show when={loading() && !profile()}>
        <p>Loading profile…</p>
      </Show>

      <Show when={profile()}>
        {() => {
          const user = profile();
          return (
            <div class="profile-container">
              <div class="profile-card">
                <div class="profile-header">
                  <h2>{user.username || `user-${user.id}`}</h2>
                  <p class="muted">{user.email}</p>
                  <p class="muted">Joined {user.created_at ? new Date(user.created_at).toLocaleDateString() : 'unknown date'}</p>
                </div>

                <div class="profile-stats">
                  <p>{followers().length || countFromResponse(followers())} followers</p>
                  <p>{following().length || countFromResponse(following())} following</p>
                  <p>Reputation: {reputation().rep_points.toFixed(1)}</p>
                  <p>Rank: {reputation().rank ? `#${reputation().rank}` : 'N/A'}</p>
                  <p>Predictions: {reputation().total_predictions}</p>
                </div>

                <div class="profile-bio">
                  <h3>Bio</h3>
                  <p>{user.bio || 'No bio provided yet.'}</p>
                </div>

                <Show when={isAuthenticated() && !isOwnProfile()}>
                  <div class="profile-actions">
                    <button
                      type="button"
                      class={`post-action ${followingStatus() ? 'liked' : ''}`}
                      onClick={toggleFollow}
                      disabled={loading()}
                    >
                      {followingStatus() ? 'Unfollow' : 'Follow'}
                    </button>
                    <button
                      type="button"
                      class="post-action"
                      onClick={handleMessage}
                      disabled={loading()}
                    >
                      Message
                    </button>
                  </div>
                </Show>

                <Show when={isOwnProfile()}>
                  <div class="profile-actions">
                    <button
                      type="button"
                      class="post-action"
                      onClick={() => {
                        setEditing((next) => !next);
                        setActionMessage('');
                        setActionError('');
                      }}
                    >
                      {editing() ? 'Cancel' : 'Edit Profile'}
                    </button>
                  </div>
                </Show>

                <Show when={actionError()}>
                  <p class="error">{actionError()}</p>
                </Show>
                <Show when={actionMessage()}>
                  <p class="success">{actionMessage()}</p>
                </Show>
                <Show when={messageUserId() && !error() && !actionError()}>
                  <p class="success">{messageUserId()}</p>
                </Show>

                <Show when={editing()}>
                  <form class="profile-edit-form" onSubmit={handleProfileSave}>
                    <label class="form-group">
                      <span>Username</span>
                      <input
                        class="form-input"
                        value={usernameInput()}
                        onInput={(event) => setUsernameInput(event.target.value)}
                        disabled={savingProfile()}
                        autocomplete="off"
                      />
                    </label>
                    <label class="form-group">
                      <span>Bio</span>
                      <textarea
                        class="form-textarea"
                        value={bioInput()}
                        onInput={(event) => setBioInput(event.target.value)}
                        disabled={savingProfile()}
                        maxLength="500"
                      />
                    </label>
                    <div class="form-actions">
                      <button
                        type="submit"
                        class="post-action submit-button"
                        disabled={savingProfile()}
                      >
                        {savingProfile() ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </form>
                </Show>
              </div>

              <div class="profile-side">
                <h3>Recent Followers</h3>
                <ul class="profile-users">
                  <For each={followers()}>
                    {(follower) => (
                      <li>
                        <button
                          class="notification-link"
                          onClick={() => {
                            if (follower?.id) {
                              window.location.hash = `#user/${follower.id}`;
                            }
                          }}
                        >
                          {follower.username || `user-${follower.id}`}
                        </button>
                      </li>
                    )}
                  </For>
                  <Show when={followers().length === 0}>
                    <li>No followers yet.</li>
                  </Show>
                </ul>

                <h3>Recent Following</h3>
                <ul class="profile-users">
                  <For each={following()}>
                    {(followingUser) => (
                      <li>
                        <button
                          class="notification-link"
                          onClick={() => {
                            if (followingUser?.id) {
                              window.location.hash = `#user/${followingUser.id}`;
                            }
                          }}
                        >
                          {followingUser.username || `user-${followingUser.id}`}
                        </button>
                      </li>
                    )}
                  </For>
                  <Show when={following().length === 0}>
                    <li>Not following anyone yet.</li>
                  </Show>
                </ul>
              </div>
            </div>
          );
        }}
      </Show>
    </section>
  );
}
