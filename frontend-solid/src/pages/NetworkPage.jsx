import { createResource, createSignal, lazy, Show, Suspense } from 'solid-js';
import { api, followUser, unfollowUser, getFollowingStatus } from '../services/api';
import { getCurrentUserId, isAuthenticated } from '../services/auth';
import Card from '../components/common/Card';

// three.js is heavy; keep it out of the main bundle.
const SocialGraph3D = lazy(() => import('../components/network/SocialGraph3D'));

const fetchGraph = async () => {
  const response = await api.network.getGraph();
  return {
    nodes: response.nodes || [],
    edges: response.edges || []
  };
};

export default function NetworkPage() {
  const [graph] = createResource(fetchGraph);
  const [selected, setSelected] = createSignal(null);
  const [following, setFollowing] = createSignal(null);
  const [followBusy, setFollowBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const isSelf = () => selected() && String(selected().id) === String(getCurrentUserId() || '');

  const selectUser = async (node) => {
    setSelected(node);
    setFollowing(null);
    setError('');
    if (!node || isSelf()) return;
    try {
      const status = await getFollowingStatus(node.id);
      setFollowing(Boolean(status?.isFollowing));
    } catch {
      setFollowing(null);
    }
  };

  const toggleFollow = async () => {
    const node = selected();
    if (!node || followBusy()) return;
    try {
      setFollowBusy(true);
      setError('');
      if (following()) {
        await unfollowUser(node.id);
        setFollowing(false);
      } else {
        await followUser(node.id);
        setFollowing(true);
      }
    } catch (err) {
      setError(err?.message || 'Failed to update follow.');
    } finally {
      setFollowBusy(false);
    }
  };

  if (!isAuthenticated()) {
    return (
      <Card title="Network" className="network-page">
        <p>Sign in to explore the follow network.</p>
      </Card>
    );
  }

  return (
    <Card title="Network" className="network-page">
      <p class="network-subtitle">
        The follow graph in 3D - node size is follower count, color is
        forecasting accuracy. Drag to orbit, click a node to inspect.
      </p>

      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>

      <Show when={!graph.loading} fallback={<p class="loading">Loading network…</p>}>
        <div class="network-layout">
          <Suspense fallback={<p class="loading">Loading 3D view…</p>}>
            <SocialGraph3D
              nodes={graph()?.nodes}
              edges={graph()?.edges}
              onSelect={(node) => void selectUser(node)}
            />
          </Suspense>

          <div class="network-side-panel">
            <Show when={selected()} fallback={
              <div class="network-stats">
                <h3>Graph</h3>
                <p>{graph()?.nodes?.length ?? 0} users · {graph()?.edges?.length ?? 0} follows</p>
                <p class="network-hint">Click a node to see the user.</p>
              </div>
            }>
              <div class="network-user-card">
                <h3>{selected().username}</h3>
                <p>
                  {selected().followers} follower{selected().followers === 1 ? '' : 's'}
                  {selected().accuracy_percent != null ? ` · ${selected().accuracy_percent}% accuracy` : ''}
                </p>
                <div class="network-user-actions">
                  <a class="post-action" href={`#profile/${selected().id}`}>View profile</a>
                  <Show when={!isSelf() && following() !== null}>
                    <button type="button" class="post-action" disabled={followBusy()} onClick={() => void toggleFollow()}>
                      {followBusy() ? '…' : following() ? 'Unfollow' : 'Follow'}
                    </button>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </Card>
  );
}
