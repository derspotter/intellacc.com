import { createMemo, createSignal, For, Show } from 'solid-js';
import { api, followUser, unfollowUser } from '../../../services/api';
import { getCurrentUserId, isAuthenticated } from '../../../services/auth';
import { applyGraphFilters } from '../../../lib/graphFilters';

// Terminal twin of the van page's three.js 3D follow graph: same data
// (`api.network.getGraph()` -> { nodes: [{id, username, followers,
// accuracy_percent}], edges: [[fromId, toId], ...] }), rendered as a
// dependency-free sortable table instead. NO three.js / SocialGraph3D here.

const MAX_NODES_OPTIONS = [50, 100, 250];

const SORTERS = {
  username: (n) => (n.username || '').toLowerCase(),
  followers: (n) => Number(n.followers) || 0,
  accuracy_percent: (n) => (n.accuracy_percent == null ? -Infinity : Number(n.accuracy_percent)),
  degree: (n) => n.degree || 0
};

export default function NetworkView() {
  const authed = isAuthenticated();

  const [graph, setGraph] = createSignal({ nodes: [], edges: [] });
  const [loading, setLoading] = createSignal(authed);
  const [error, setError] = createSignal('');

  const [hideIso, setHideIso] = createSignal(false);
  const [largestOnly, setLargestOnly] = createSignal(false);
  const [maxNodes, setMaxNodes] = createSignal(100);
  const [query, setQuery] = createSignal('');
  const [sortKey, setSortKey] = createSignal('followers');
  const [sortDir, setSortDir] = createSignal('desc');
  const [followed, setFollowed] = createSignal(new Set());

  if (authed) {
    api.network.getGraph()
      .then((res) => setGraph({ nodes: res?.nodes || [], edges: res?.edges || [] }))
      .catch((e) => setError(e?.message || 'FAILED TO LOAD NETWORK'))
      .finally(() => setLoading(false));
  }

  // Filtered graph (isolates / largest-cluster / max-nodes cap), same pure
  // helpers the van page uses.
  const displayed = createMemo(() =>
    applyGraphFilters(graph(), {
      hideIsolates: hideIso(),
      largestClusterOnly: largestOnly(),
      maxNodes: Number(maxNodes()) || null
    })
  );

  // Degree = number of edges touching the node, recomputed once per
  // filtered-graph change (edges are [fromId, toId] pairs, not objects).
  const degreeMap = createMemo(() => {
    const map = new Map();
    for (const edge of displayed().edges) {
      const a = Number(edge[0]);
      const b = Number(edge[1]);
      map.set(a, (map.get(a) || 0) + 1);
      map.set(b, (map.get(b) || 0) + 1);
    }
    return map;
  });

  const rows = createMemo(() => {
    const degrees = degreeMap();
    const q = query().trim().toLowerCase();
    let list = displayed().nodes.map((n) => ({ ...n, degree: degrees.get(Number(n.id)) || 0 }));
    if (q) list = list.filter((n) => (n.username || '').toLowerCase().includes(q));

    const key = sortKey();
    const dir = sortDir() === 'asc' ? 1 : -1;
    const getter = SORTERS[key] || SORTERS.followers;
    return [...list].sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tie-break so re-sorts don't jitter rows with equal values.
      return Number(a.id) - Number(b.id);
    });
  });

  const toggleSort = (key) => {
    if (sortKey() === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'username' ? 'asc' : 'desc');
    }
  };

  const sortArrow = (key) => (sortKey() === key ? (sortDir() === 'asc' ? ' ▲' : ' ▼') : '');

  const isSelf = (node) => {
    const current = getCurrentUserId();
    return current != null && String(node.id) === String(current);
  };

  const toggleFollow = async (node) => {
    const id = String(node.id);
    const wasFollowing = followed().has(id);
    setFollowed((prev) => {
      const next = new Set(prev);
      if (wasFollowing) next.delete(id); else next.add(id);
      return next;
    });
    try {
      if (wasFollowing) await unfollowUser(node.id); else await followUser(node.id);
    } catch {
      setFollowed((prev) => {
        const next = new Set(prev);
        if (wasFollowing) next.add(id); else next.delete(id);
        return next;
      });
    }
  };

  const goToUser = (node) => { window.location.hash = `#user/${node.id}`; };

  const headerCell = (key, label, extraClass = '') => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      class={`text-left uppercase hover:text-bb-accent ${sortKey() === key ? 'text-bb-accent font-bold' : ''} ${extraClass}`}
    >
      {label}{sortArrow(key)}
    </button>
  );

  return (
    <Show
      when={authed}
      fallback={
        <div class="h-full flex items-center justify-center font-mono text-sm text-bb-muted p-6 text-center">
          SIGN IN TO EXPLORE THE NETWORK
        </div>
      }
    >
      <div class="h-full flex flex-col font-mono text-sm">
        <div class="shrink-0 border-b border-bb-border bg-bb-panel px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setHideIso((v) => !v)}
            class={`px-2 py-0.5 border uppercase font-bold ${hideIso() ? 'border-bb-accent text-bb-accent bg-bb-accent/20' : 'border-bb-border text-bb-muted hover:text-bb-text'}`}
          >
            [HIDE ISOLATES]
          </button>
          <button
            type="button"
            onClick={() => setLargestOnly((v) => !v)}
            class={`px-2 py-0.5 border uppercase font-bold ${largestOnly() ? 'border-bb-accent text-bb-accent bg-bb-accent/20' : 'border-bb-border text-bb-muted hover:text-bb-text'}`}
          >
            [LARGEST CLUSTER]
          </button>
          <label class="flex items-center gap-1 text-bb-muted">
            MAX
            <select
              value={maxNodes()}
              onChange={(e) => setMaxNodes(Number(e.currentTarget.value))}
              class="bg-bb-bg border border-bb-border text-bb-text px-1 py-0.5"
            >
              <For each={MAX_NODES_OPTIONS}>
                {(n) => <option value={n}>{n}</option>}
              </For>
            </select>
          </label>
          <input
            type="text"
            data-testid="network-search"
            class="flex-1 min-w-[8rem] bg-transparent border border-bb-border px-2 py-0.5 outline-none text-bb-text placeholder-bb-muted"
            placeholder="SEARCH USERNAME..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <span class="text-bb-muted">
            {displayed().nodes.length} / {graph().nodes.length} USERS &middot; {displayed().edges.length} / {graph().edges.length} FOLLOWS
          </span>
        </div>

        <div class="grid grid-cols-[minmax(0,1fr)_10ch_8ch_8ch_12ch] gap-2 px-3 py-1 border-b border-bb-border bg-bb-panel text-xs select-none">
          {headerCell('username', 'USER')}
          {headerCell('followers', 'FOLLOWERS', 'text-right')}
          {headerCell('accuracy_percent', 'ACC%', 'text-right')}
          {headerCell('degree', 'DEGREE', 'text-right')}
          <div class="text-right text-bb-muted uppercase">FOLLOW</div>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar">
          <Show when={error()}>
            <div class="p-3 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
          </Show>
          <Show when={loading()}>
            <div class="p-3 text-bb-muted animate-pulse text-xs">LOADING NETWORK...</div>
          </Show>
          <Show when={!loading() && !error()}>
            <Show
              when={rows().length > 0}
              fallback={<div data-testid="network-empty" class="p-4 text-bb-muted">NO USERS IN VIEW</div>}
            >
              <For each={rows()}>
                {(node, index) => (
                  <div
                    data-testid="network-row"
                    onClick={() => goToUser(node)}
                    class={`grid grid-cols-[minmax(0,1fr)_10ch_8ch_8ch_12ch] gap-2 px-3 py-1 border-b border-bb-border/20 text-xs cursor-pointer hover:bg-white/5 ${index() % 2 === 0 ? 'bg-bb-bg' : 'bg-[#0a0a0a]'}`}
                  >
                    <div class="truncate font-bold text-bb-text">@{node.username || `USER ${node.id}`}</div>
                    <div class="text-right text-bb-muted">{node.followers ?? 0}</div>
                    <div class="text-right text-bb-muted">{node.accuracy_percent != null ? `${node.accuracy_percent}%` : '--'}</div>
                    <div class="text-right text-bb-muted">{node.degree}</div>
                    <div class="text-right">
                      <Show when={!isSelf(node)}>
                        <button
                          type="button"
                          data-testid="network-follow"
                          onClick={(e) => { e.stopPropagation(); toggleFollow(node); }}
                          class="px-2 py-0.5 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase text-xxs font-bold"
                        >
                          {followed().has(String(node.id)) ? '[FOLLOWING]' : '[FOLLOW]'}
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
