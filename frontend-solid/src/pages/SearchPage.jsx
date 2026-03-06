import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import PostItem from '../components/posts/PostItem';
import api from '../services/api';
import { isAuthenticated } from '../services/auth';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 20;

export default function SearchPage(props) {
  const showHeader = props.showHeader !== false;
  const showHints = props.showHints !== false;

  const [activeTab, setActiveTab] = createSignal('posts');
  const [query, setQuery] = createSignal('');
  const [postScope, setPostScope] = createSignal('global');
  const [posts, setPosts] = createSignal([]);
  const [users, setUsers] = createSignal([]);
  const [loadingPosts, setLoadingPosts] = createSignal(false);
  const [loadingUsers, setLoadingUsers] = createSignal(false);
  const [postsError, setPostsError] = createSignal('');
  const [usersError, setUsersError] = createSignal('');
  const [postsHasMore, setPostsHasMore] = createSignal(false);
  const [postsCursor, setPostsCursor] = createSignal(null);
  const [hasSearched, setHasSearched] = createSignal(false);
  const [followError, setFollowError] = createSignal('');
  const [followBusyStates, setFollowBusyStates] = createSignal({});

  let searchTimeout = null;

  const postScopeOptions = () => {
    if (!isAuthenticated()) {
      return [{ value: 'global', label: 'All Posts' }];
    }
    return [
      { value: 'global', label: 'All Posts' },
      { value: 'following', label: 'Following' },
      { value: 'seen', label: 'Seen Posts' }
    ];
  };

  const setFollowBusy = (userId, busy) => {
    setFollowBusyStates(prev => ({ ...prev, [userId]: busy }));
  };

  const isFollowBusy = (userId) => !!followBusyStates()[userId];

  const runPostsSearch = async ({ append = false } = {}) => {
    const currentQuery = String(query() || '').trim();
    if (!currentQuery) {
      if (!append) {
        setPosts([]);
        setPostsHasMore(false);
        setPostsCursor(null);
      }
      return;
    }

    if (loadingPosts()) return;

    setLoadingPosts(true);
    setPostsError('');
    if (!append) {
      setPostsCursor(null);
      setPosts([]);
      setPostsHasMore(false);
    }

    try {
      const currentScope = postScope();
      const options = {
        q: currentQuery,
        limit: SEARCH_PAGE_SIZE,
        cursor: append ? postsCursor() : null
      };
      
      const page = currentScope === 'following'
        ? await api.posts.getFeedPage(options)
        : await api.posts.getPage({
            ...options,
            ...(currentScope === 'global' ? {} : { scope: currentScope })
          });

      const results = Array.isArray(page?.items) ? page.items : [];
      const existingIds = new Set(append ? posts().map((post) => String(post.id)) : []);
      const merged = append
        ? [...posts(), ...results.filter((post) => !existingIds.has(String(post.id)))]
        : results;

      setPosts(merged);
      setPostsCursor(page?.nextCursor || null);
      setPostsHasMore(!!page?.hasMore);
    } catch (error) {
      setPostsError(error?.message || 'Post search failed');
    } finally {
      setLoadingPosts(false);
      setHasSearched(true);
    }
  };

  const runUsersSearch = async () => {
    const currentQuery = String(query() || '').trim();
    if (!currentQuery) {
      setUsers([]);
      return;
    }

    if (loadingUsers()) return;

    setLoadingUsers(true);
    setUsersError('');

    try {
      const result = await api.users.search(currentQuery, {
        includeFollowing: true
      });
      const list = Array.isArray(result) ? result : [];
      setUsers(list);
    } catch (error) {
      setUsersError(error?.message || 'User search failed');
      setUsers([]);
    } finally {
      setLoadingUsers(false);
      setHasSearched(true);
    }
  };

  const runSearch = () => {
    setPostsError('');
    setUsersError('');
    setFollowError('');
    if (activeTab() === 'posts') {
      runPostsSearch({ append: false });
    } else {
      runUsersSearch();
    }
  };

  const handleQueryInput = (value) => {
    setQuery(value);
    setHasSearched(false);
    setPosts([]);
    setUsers([]);

    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      runSearch();
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleTabChange = (tab) => {
    if (activeTab() === tab) return;
    setActiveTab(tab);
    setPostsError('');
    setUsersError('');
    setFollowError('');
    setPosts([]);
    setUsers([]);
    setPostsCursor(null);
    setPostsHasMore(false);
    setHasSearched(false);
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }
    if (String(query() || '').trim()) {
      runSearch();
    }
  };

  const handleScopeChange = (scopeValue) => {
    if (postScope() === scopeValue) return;
    setPostScope(scopeValue);
    setPosts([]);
    setPostsCursor(null);
    setPostsHasMore(false);
    setHasSearched(false);
    if (String(query() || '').trim()) {
      runPostsSearch({ append: false });
    }
  };

  const handleLoadMorePosts = () => {
    if (!postsHasMore() || loadingPosts()) return;
    runPostsSearch({ append: true });
  };

  const handleFollowToggle = async (user) => {
    if (!isAuthenticated()) {
      window.location.hash = '#login';
      return;
    }

    if (isFollowBusy(user.id)) return;

    setFollowBusy(user.id, true);
    setFollowError('');

    try {
      if (user.is_following) {
        await api.users.unfollow(user.id);
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_following: false } : u));
      } else {
        await api.users.follow(user.id);
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_following: true } : u));
      }
    } catch (error) {
      setFollowError(error?.message || 'Unable to update follow status.');
    } finally {
      setFollowBusy(user.id, false);
    }
  };

  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout);
  });

  return (
    <div class="search-page">
      <Show when={showHeader}>
        <h2>Search</h2>
      </Show>
      <div class="search-toolbar">
        <div class="search-tab-row">
          <button
            type="button"
            class="search-tab"
            classList={{ active: activeTab() === 'posts' }}
            style={{
              "border-radius": "0 !important",
              "background": "var(--card-bg) !important",
              "border-color": activeTab() === 'posts' ? 'var(--signature-blue)' : 'var(--border-color)',
              "box-shadow": activeTab() === 'posts' ? '0 0 0 2px var(--focus-ring)' : 'none'
            }}
            onClick={() => handleTabChange('posts')}
          >
            Posts
          </button>
          <button
            type="button"
            class="search-tab"
            classList={{ active: activeTab() === 'users' }}
            style={{
              "border-radius": "0 !important",
              "background": "var(--card-bg) !important",
              "border-color": activeTab() === 'users' ? 'var(--signature-blue)' : 'var(--border-color)',
              "box-shadow": activeTab() === 'users' ? '0 0 0 2px var(--focus-ring)' : 'none'
            }}
            onClick={() => handleTabChange('users')}
          >
            Users
          </button>
        </div>
        <input
          class="search-input"
          type="search"
          placeholder={activeTab() === 'posts' ? "Search posts..." : "Search people..."}
          value={query()}
          onInput={(e) => handleQueryInput(e.target.value)}
        />
      </div>

      <Show when={activeTab() === 'posts'}>
        <div class="search-scope-row">
          <For each={postScopeOptions()}>
            {(option) => (
              <button
                type="button"
                class="search-scope"
                style={{
                  "border-radius": "0 !important",
                  "background": "var(--card-bg) !important",
                  "border-color": postScope() === option.value ? 'var(--signature-blue)' : 'var(--border-color)',
                  "box-shadow": postScope() === option.value ? '0 0 0 2px var(--focus-ring)' : 'none'
                }}
                onClick={() => handleScopeChange(option.value)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="search-result-area">
        <Show when={followError()}>
          <div class="error">{followError()}</div>
        </Show>
        
        <Show when={activeTab() === 'posts'}>
          <div class="search-post-results">
            <Show when={!query() && showHints}>
              <p class="search-hint">Type a term to search posts.</p>
            </Show>
            <Show when={loadingPosts() && posts().length === 0}>
              <div class="loading">Searching posts...</div>
            </Show>
            <Show when={postsError()}>
              <div class="error">{postsError()}</div>
            </Show>
            <Show when={posts().length === 0 && hasSearched() && query()}>
              <p class="search-empty">No posts found.</p>
            </Show>
            <For each={posts()}>
              {(post) => (
                <div class="search-post-result">
                  <PostItem post={post} />
                </div>
              )}
            </For>
            <Show when={postsHasMore()}>
              <button
                class="search-load-more"
                onClick={handleLoadMorePosts}
                disabled={loadingPosts()}
              >
                {loadingPosts() ? 'Loading…' : 'Load More'}
              </button>
            </Show>
          </div>
        </Show>

        <Show when={activeTab() === 'users'}>
          <div class="search-user-list">
            <Show when={!query() && showHints}>
              <p class="search-hint">Type a term to search people.</p>
            </Show>
            <Show when={loadingUsers() && users().length === 0}>
              <div class="loading">Searching users...</div>
            </Show>
            <Show when={usersError()}>
              <div class="error">{usersError()}</div>
            </Show>
            <Show when={users().length === 0 && hasSearched() && query()}>
              <p class="search-empty">No users found.</p>
            </Show>
            <For each={users()}>
              {(user) => (
                <div class="search-user-row">
                  <a
                    class="search-user-link"
                    href={`#user/${user.id}`}
                  >
                    <div class="search-user-avatar">{String(user.username?.[0] || '?').toUpperCase()}</div>
                    <div class="search-user-main">
                      <span class="search-user-name">{user.username}</span>
                      <span class="search-user-id">ID {user.id}</span>
                    </div>
                  </a>
                  <button
                    class={`search-follow-btn ${user.is_following ? 'following' : 'not-following'}`}
                    onClick={() => handleFollowToggle(user)}
                    disabled={isFollowBusy(user.id)}
                  >
                    {isFollowBusy(user.id) ? "..." : (user.is_following ? "Unfollow" : "Follow")}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
