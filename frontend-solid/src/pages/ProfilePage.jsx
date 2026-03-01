import { createEffect, createSignal, For, Show } from 'solid-js';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import {
  createDirectMessage,
  followUser,
  getCurrentUser,
  getFollowers,
  getFollowing,
  getFollowingStatus,
  getPredictions,
  getUser,
  getUserReputation,
  unfollowUser,
  updateProfile
} from '../services/api';
import { getCurrentUserId, isAuthenticated } from '../services/auth';

const MAX_PREVIEW_PREDICTIONS = 5;
const EMPTY_BIO_TEXT = 'No bio provided yet.';

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

const hasValidReputation = (reputation) =>
  !!(reputation && (reputation.rank || reputation.total_predictions || reputation.rep_points));

const extractRows = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  if (Array.isArray(payload?.followers)) {
    return payload.followers;
  }
  if (Array.isArray(payload?.following)) {
    return payload.following;
  }
  return [];
};

const extractPredictionItems = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  if (Array.isArray(payload?.predictions)) {
    return payload.predictions;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  return [];
};

const getPredictionLabel = (prediction) => {
  const value = prediction?.prediction_value;
  if (value === null || value === undefined) {
    return 'Unknown';
  }
  if (typeof value === 'number') {
    return `${value}`;
  }
  return `${value}`;
};

const getPredictionOutcome = (prediction) => {
  if (prediction?.outcome) {
    return prediction.outcome;
  }
  return 'Pending';
};

export default function ProfilePage(props) {
  const [profile, setProfile] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const [followers, setFollowers] = createSignal([]);
  const [following, setFollowing] = createSignal([]);
  const [followingStatus, setFollowingStatus] = createSignal(false);

  const [reputation, setReputation] = createSignal(normalizeReputation({}));
  const [reputationLoading, setReputationLoading] = createSignal(false);

  const [editing, setEditing] = createSignal(false);
  const [usernameInput, setUsernameInput] = createSignal('');
  const [bioInput, setBioInput] = createSignal('');
  const [savingProfile, setSavingProfile] = createSignal(false);

  const [actionError, setActionError] = createSignal('');
  const [actionMessage, setActionMessage] = createSignal('');

  const [predictions, setPredictions] = createSignal([]);
  const [networkLoaded, setNetworkLoaded] = createSignal(false);
  const [networkLoading, setNetworkLoading] = createSignal(false);
  const [activeNetworkTab, setActiveNetworkTab] = createSignal('followers');

  const targetUserId = () => normalizeId(props.userId?.() || props.userId || null);

  const isOwnProfile = () => {
    const target = targetUserId();
    if (target) {
      return String(getCurrentUserId() || '') === String(target);
    }
    return isAuthenticated();
  };

  const fetchReputation = async (userId) => {
    setReputationLoading(true);
    try {
      const payload = await getUserReputation(userId).catch(() => null);
      setReputation(normalizeReputation(payload || {}));
    } catch {
      setReputation(normalizeReputation({}));
    } finally {
      setReputationLoading(false);
    }
  };

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
        throw new Error('Profile data missing or invalid.');
      }

      const normalizedProfile = coerceUser(baseProfile);
      setProfile(normalizedProfile);
      setUsernameInput(normalizedProfile.username);
      setBioInput(normalizedProfile.bio);
      setFollowers([]);
      setFollowing([]);
      setNetworkLoaded(false);

      const isSelf = String(normalizedProfile.id) === String(getCurrentUserId() || '');
      await fetchReputation(normalizedProfile.id);

      const predictionRows = isSelf ? await getPredictions().catch(() => []) : [];
      setPredictions(extractPredictionItems(predictionRows));

      if (isAuthenticated() && !isSelf) {
        const status = await getFollowingStatus(normalizedProfile.id).catch(() => null);
        setFollowingStatus(Boolean(status?.isFollowing));
      } else {
        setFollowingStatus(false);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load profile.');
      setProfile(null);
      setPredictions([]);
      setReputation(normalizeReputation({}));
    } finally {
      setLoading(false);
    }
  };

  const loadNetworkData = async () => {
    const currentProfile = profile();
    if (!currentProfile || networkLoading()) {
      return;
    }

    try {
      setNetworkLoading(true);
      setActionError('');
      const followerRows = await getFollowers(currentProfile.id).catch(() => []);
      const followingRows = await getFollowing(currentProfile.id).catch(() => []);
      setFollowers(extractRows(followerRows));
      setFollowing(extractRows(followingRows));
      setNetworkLoaded(true);
    } catch (err) {
      setActionError(err?.message || 'Could not load network data.');
    } finally {
      setNetworkLoading(false);
    }
  };

  const handleProfileSave = async (event) => {
    event.preventDefault();
    const currentProfile = profile();
    if (!currentProfile || !isOwnProfile()) {
      return;
    }

    const username = usernameInput().trim();
    const bio = bioInput().trim();

    if (!username) {
      setActionError('Username is required.');
      return;
    }

    setSavingProfile(true);
    setActionError('');
    setActionMessage('');

    try {
      await updateProfile({
        username,
        bio
      });
      setProfile((current) => ({ ...current, username, bio }));
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

    const userId = currentProfile.id;
    if (!userId) {
      return;
    }

    try {
      setActionError('');
      setActionMessage('');
      if (followingStatus()) {
        await unfollowUser(userId);
        setFollowingStatus(false);
      } else {
        await followUser(userId);
        setFollowingStatus(true);
      }
      if (networkLoaded()) {
        setFollowers((current) =>
          followingStatus()
            ? current.filter((entry) => String(entry.id) !== String(getCurrentUserId() || ''))
            : current
        );
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
      await createDirectMessage(parsed);
      window.location.hash = 'messages';
    } catch (err) {
      setActionError(err?.message || 'Failed to create message thread.');
    }
  };

  createEffect(() => {
    targetUserId();
    fetchProfile();
  });

  return (
    <section class="profile-page">
      <Show when={!isOwnProfile()}>
        <button
          type="button"
          class="back-button"
          onClick={() => {
            window.history.back();
          }}
        >
          ← Back
        </button>
      </Show>

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
          const isSelf = isOwnProfile();
          const predictionCount = predictions().length;

          return (
            <div class="profile-container">
              <div class="profile-column main">
                <Card title={isSelf ? 'Profile' : ''} className="profile-card">
                  <div class="profile-content">
                    <h3 class="username">{user.username || `user-${user.id}`}</h3>

                    <Show when={isSelf}>
                      <Show when={user.email}>
                        <div class="email-section">
                          <h4>Email</h4>
                          <p class="email">{user.email}</p>
                        </div>
                      </Show>
                    </Show>

                    <div class="reputation-section">
                      <h4>Reputation</h4>
                      <Show when={reputationLoading()}>
                        <p class="reputation-loading">Loading reputation...</p>
                      </Show>
                      <Show when={!reputationLoading()}>
                        <Show
                          when={hasValidReputation(reputation())}
                          fallback={<p class="reputation-none">Make predictions to build reputation</p>}
                        >
                          <div class="reputation-stats">
                            <div class="reputation-item">
                              <span class="reputation-label">Points: </span>
                              <span class="reputation-value points-value">
                                {reputation().rep_points.toFixed(1)}
                              </span>
                            </div>
                            <div class="reputation-item">
                              <span class="reputation-label">Global Rank: </span>
                              <span class="reputation-value rank-value">
                                {reputation().rank ? `#${reputation().rank}` : 'Unranked'}
                              </span>
                            </div>
                            <div class="reputation-item">
                              <span class="reputation-label">Predictions: </span>
                              <span class="reputation-value predictions-value">
                                {reputation().total_predictions}
                              </span>
                            </div>
                          </div>
                        </Show>
                      </Show>
                    </div>

                    <div class="bio-section">
                      <h4>Bio</h4>
                      <p class="bio">{user.bio || EMPTY_BIO_TEXT}</p>
                    </div>

                    <Show when={isAuthenticated() && !isSelf}>
                      <div class="profile-actions">
                        <Button
                          type="button"
                          className={`follow-button ${followingStatus() ? 'following' : 'not-following'}`}
                          onClick={toggleFollow}
                          disabled={loading()}
                        >
                          {followingStatus() ? 'Unfollow' : 'Follow'}
                        </Button>
                        <Button
                          type="button"
                          className="message-button"
                          variant="secondary"
                          onClick={handleMessage}
                          disabled={loading()}
                        >
                          Message
                        </Button>
                      </div>
                    </Show>

                    <Show when={isSelf}>
                      <Button
                        type="button"
                        className="edit-profile-button"
                        variant="primary"
                        onClick={() => {
                          setEditing((next) => !next);
                          setActionMessage('');
                          setActionError('');
                        }}
                      >
                        {editing() ? 'Cancel' : 'Edit Profile'}
                      </Button>
                    </Show>

                    <Show when={actionError()}>
                      <p class="error">{actionError()}</p>
                    </Show>
                    <Show when={actionMessage()}>
                      <p class="success">{actionMessage()}</p>
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
                          <Button
                            type="submit"
                            className="post-action submit-button"
                            variant="primary"
                            disabled={savingProfile()}
                          >
                            {savingProfile() ? 'Saving…' : 'Save'}
                          </Button>
                        </div>
                      </form>
                    </Show>
                  </div>
                </Card>

                <Show when={isSelf}>
                  <Card title="Your Predictions" className="predictions-list profile-predictions">
                    <Show when={predictionCount === 0}>
                      <p>You haven't made any predictions yet.</p>
                    </Show>
                    <Show when={predictionCount > 0}>
                      <div class="prediction-list-compact">
                        <For each={predictions().slice(0, MAX_PREVIEW_PREDICTIONS)}>
                          {(prediction) => (
                            <div class={`prediction-item ${prediction.outcome ? 'resolved' : 'pending'}`}>
                              <div class="prediction-event">
                                {prediction.event || prediction.title || 'Unknown event'}
                              </div>
                              <div class="prediction-details">
                                <span>
                                  {getPredictionLabel(prediction)} ({prediction.confidence || 0}%)
                                </span>
                                <span class={`prediction-outcome ${prediction.outcome ? 'resolved' : 'pending'}`}>
                                  {getPredictionOutcome(prediction)}
                                </span>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={predictionCount > MAX_PREVIEW_PREDICTIONS}>
                      <div class="predictions-actions">
                        <Button
                          type="button"
                          className="view-all-button"
                          variant="primary"
                          onClick={() => {
                            window.location.hash = 'predictions';
                          }}
                        >
                          View All Predictions
                        </Button>
                      </div>
                    </Show>
                  </Card>
                </Show>
              </div>

              <Show when={isSelf || networkLoaded()}>
                <Card title={isSelf ? 'Your Network' : 'Network'} className="network-tabs">
                  <button
                    type="button"
                    class="load-network-button"
                    onClick={loadNetworkData}
                    disabled={networkLoading()}
                  >
                    {networkLoading() ? 'Loading...' : 'Load Network Data'}
                  </button>

                  <div class="network-stats">
                    <button
                      type="button"
                      class={`network-tab ${activeNetworkTab() === 'followers' ? 'active' : ''}`}
                      onClick={() => setActiveNetworkTab('followers')}
                    >
                      Followers: <span class="count">{followers().length}</span>
                    </button>
                    <button
                      type="button"
                      class={`network-tab ${activeNetworkTab() === 'following' ? 'active' : ''}`}
                      onClick={() => setActiveNetworkTab('following')}
                    >
                      Following: <span class="count">{following().length}</span>
                    </button>
                  </div>

                  <div class="network-tab-content">
                    <Show when={activeNetworkTab() === 'followers'}>
                      <div class="followers-tab">
                        <h4>{isSelf ? 'People following you' : 'Followers'}</h4>
                        <Show when={followers().length === 0}>
                          <div class="no-users">No followers yet.</div>
                        </Show>
                        <For each={followers()}>
                          {(follower) => (
                            <button
                              type="button"
                              class="notification-link"
                              onClick={() => {
                                if (follower?.id) {
                                  window.location.hash = `#user/${follower.id}`;
                                }
                              }}
                            >
                              {follower.username || `user-${follower.id}`}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={activeNetworkTab() === 'following'}>
                      <div class="following-tab">
                        <h4>{isSelf ? 'People you follow' : 'Following'}</h4>
                        <Show when={following().length === 0}>
                          <div class="no-users">Not following anyone yet.</div>
                        </Show>
                        <For each={following()}>
                          {(followingUser) => (
                            <button
                              type="button"
                              class="notification-link"
                              onClick={() => {
                                if (followingUser?.id) {
                                  window.location.hash = `#user/${followingUser.id}`;
                                }
                              }}
                            >
                              {followingUser.username || `user-${followingUser.id}`}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Card>
              </Show>
            </div>
          );
        }}
      </Show>
    </section>
  );
}
