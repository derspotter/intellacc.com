import { createResource, createSignal, createMemo, lazy, Show, Suspense } from 'solid-js';
import { api, followUser, unfollowUser, getFollowingStatus } from '../services/api';
import { getCurrentUserId, isAuthenticated } from '../services/auth';
import Card from '../components/common/Card';
import { applyGraphFilters } from '../lib/graphFilters';

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

  const [maxNodes, setMaxNodes] = createSignal(200);
  const [hideIso, setHideIso] = createSignal(false);
  const [largestOnly, setLargestOnly] = createSignal(false);
  const [searchInput, setSearchInput] = createSignal('');
  const [searchError, setSearchError] = createSignal('');
  const [focusNodeId, setFocusNodeId] = createSignal(null);
  const [resetSignal, setResetSignal] = createSignal(0);

  const full = () => graph() || { nodes: [], edges: [] };
  const displayed = createMemo(() =>
    applyGraphFilters(full(), {
      hideIsolates: hideIso(),
      largestClusterOnly: largestOnly(),
      maxNodes: Number(maxNodes()) || null
    })
  );

  const doSearch = (e) => {
    e?.preventDefault();
    setSearchError('');
    const q = searchInput().trim().toLowerCase();
    if (!q) return;
    const list = displayed().nodes;
    const match =
      list.find((n) => n.username?.toLowerCase() === q) ||
      list.find((n) => n.username?.toLowerCase().startsWith(q));
    if (!match) {
      setSearchError('No user in view matches.');
      return;
    }
    setFocusNodeId(match.id);
  };

  const resetView = () => {
    setMaxNodes(200);
    setHideIso(false);
    setLargestOnly(false);
    setSearchInput('');
    setSearchError('');
    setFocusNodeId(null);
    setResetSignal((v) => v + 1);
  };

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
        <form class="network-controls" onSubmit={doSearch}>
          <input
            type="text"
            placeholder="Search user…"
            value={searchInput()}
            onInput={(e) => setSearchInput(e.currentTarget.value)}
          />
          <button type="submit" class="post-action">Go</button>
          <label class="network-control-num">
            Max nodes
            <input
              type="number"
              min="1"
              value={maxNodes()}
              onInput={(e) => setMaxNodes(e.currentTarget.value)}
            />
          </label>
          <label class="network-control-check">
            <input type="checkbox" checked={hideIso()} onChange={(e) => setHideIso(e.currentTarget.checked)} />
            Hide isolates
          </label>
          <label class="network-control-check">
            <input type="checkbox" checked={largestOnly()} onChange={(e) => setLargestOnly(e.currentTarget.checked)} />
            Largest cluster only
          </label>
          <button type="button" class="post-action" onClick={resetView}>Reset view</button>
        </form>
        <Show when={searchError()}>
          <p class="network-hint">{searchError()}</p>
        </Show>

        <div class="network-layout">
          <Suspense fallback={<p class="loading">Loading 3D view…</p>}>
            <SocialGraph3D
              nodes={displayed().nodes}
              edges={displayed().edges}
              focusNodeId={focusNodeId()}
              resetSignal={resetSignal()}
              onSelect={(node) => void selectUser(node)}
            />
          </Suspense>

          <div class="network-side-panel">
            <Show when={selected()} fallback={
              <div class="network-stats">
                <h3>Graph</h3>
                <p data-testid="graph-stats">
                  showing {displayed().nodes.length} / {full().nodes.length} users ·{' '}
                  {displayed().edges.length} / {full().edges.length} follows
                </p>
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
