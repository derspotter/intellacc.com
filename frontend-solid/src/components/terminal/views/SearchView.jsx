import { For, Show, createSignal, onCleanup } from 'solid-js';
import { api, followUser, getPostsPage, getPostsPaging, unfollowUser } from '../../../services/api';
import { isLoggedIn } from '../../../services/tokenService';

export default function SearchView() {
  const [tab, setTab] = createSignal('users'); // 'users' | 'posts'
  const [query, setQuery] = createSignal('');
  const [users, setUsers] = createSignal([]);
  const [posts, setPosts] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  let debounceTimer;
  let searchEpoch = 0;
  onCleanup(() => clearTimeout(debounceTimer));

  const run = async () => {
    const q = query().trim();
    const epoch = ++searchEpoch;
    if (!q) { setUsers([]); setPosts([]); return; }
    setLoading(true);
    setError('');
    try {
      if (tab() === 'users') {
        const rows = await api.users.search(q);
        if (epoch !== searchEpoch) return;
        setUsers(Array.isArray(rows) ? rows : []);
      } else {
        // Server-side post search does not exist (van parity quirk):
        // fetch the latest page and filter client-side.
        const page = getPostsPaging(await getPostsPage({ limit: 50 }));
        if (epoch !== searchEpoch) return;
        const needle = q.toLowerCase();
        setPosts(page.items.filter(p => String(p.content || '').toLowerCase().includes(needle)));
      }
    } catch (e) {
      if (epoch === searchEpoch) setError(e?.message || 'SEARCH FAILED');
    } finally {
      if (epoch === searchEpoch) setLoading(false);
    }
  };

  const onInput = (e) => {
    setQuery(e.currentTarget.value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 300);
  };

  const switchTab = (t) => { setTab(t); run(); };

  const toggleFollow = async (u) => {
    if (!isLoggedIn()) { window.location.hash = '#login'; return; }
    const wasFollowing = Boolean(u.is_following);
    setUsers((prev) => prev.map(x => x.id === u.id ? { ...x, is_following: !wasFollowing } : x));
    try {
      if (wasFollowing) await unfollowUser(u.id); else await followUser(u.id);
    } catch {
      setUsers((prev) => prev.map(x => x.id === u.id ? { ...x, is_following: wasFollowing } : x));
    }
  };

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <div class="shrink-0 border-b border-bb-border bg-bb-panel px-3 py-2 flex items-center gap-2">
        <span class="text-bb-accent font-bold">/</span>
        <input
          type="text"
          data-testid="search-input"
          class="flex-1 bg-transparent border-none outline-none text-bb-text placeholder-bb-muted"
          placeholder="SEARCH..."
          value={query()}
          onInput={onInput}
        />
      </div>
      <div class="shrink-0 flex border-b border-bb-border bg-bb-panel text-xs select-none">
        <button type="button" onClick={() => switchTab('users')} class={`px-4 py-2 border-r border-bb-border uppercase ${tab() === 'users' ? 'bg-bb-accent/15 text-bb-accent font-bold' : 'text-bb-muted hover:text-bb-text'}`}>[USERS]</button>
        <button type="button" onClick={() => switchTab('posts')} class={`px-4 py-2 border-r border-bb-border uppercase ${tab() === 'posts' ? 'bg-bb-accent/15 text-bb-accent font-bold' : 'text-bb-muted hover:text-bb-text'}`}>[POSTS (LOADED PAGES)]</button>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <Show when={error()}>
          <div class="p-3 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
        </Show>
        <Show when={loading()}>
          <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
        </Show>
        <Show when={tab() === 'users'}>
          <Show when={users().length > 0} fallback={<Show when={!loading() && query().trim()}><div class="p-4 text-bb-muted">NO USERS FOUND</div></Show>}>
            <For each={users()}>
              {(u) => (
                <div data-testid="search-user-row" class="px-3 py-2 border-b border-bb-border/20 flex items-center justify-between gap-3 hover:bg-white/5">
                  <button type="button" class="font-bold text-left truncate hover:text-bb-accent" onClick={() => { window.location.hash = `#user/${u.id}`; }}>
                    @{u.username}
                  </button>
                  <button
                    type="button"
                    data-testid="search-follow"
                    onClick={() => toggleFollow(u)}
                    class="shrink-0 px-2 py-0.5 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase text-xxs font-bold"
                  >
                    {u.is_following ? '[UNFOLLOW]' : '[FOLLOW]'}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
        <Show when={tab() === 'posts'}>
          <Show when={posts().length > 0} fallback={<Show when={!loading() && query().trim()}><div class="p-4 text-bb-muted">NO MATCHES IN LOADED PAGES</div></Show>}>
            <For each={posts()}>
              {(p) => (
                <div class="px-3 py-2 border-b border-bb-border/20 text-xs">
                  <span class="text-bb-accent font-bold">@{p.username}</span>
                  <p class="text-bb-text whitespace-pre-wrap break-words mt-1">{p.content}</p>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
