import van from 'vanjs-core';
const { div, h2, input, button, a, p, span } = van.tags;
import PostItem from '../components/posts/PostItem';
import api from '../services/api';
import { isLoggedInState } from '../services/auth';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 20;
const followStates = {};
const followBusyStates = {};
let searchTimeout = null;

const searchState = {
  activeTab: van.state('posts'),
  query: van.state(''),
  postScope: van.state('global'),
  posts: van.state([]),
  users: van.state([]),
  loadingPosts: van.state(false),
  loadingUsers: van.state(false),
  postsError: van.state(''),
  usersError: van.state(''),
  postsHasMore: van.state(false),
  postsCursor: van.state(null),
  hasSearched: van.state(false),
  followError: van.state('')
};

export default function SearchPage() {
  const {
    activeTab,
    query,
    postScope,
    posts,
    users,
    loadingPosts,
    loadingUsers,
    postsError,
    usersError,
    postsHasMore,
    postsCursor,
    hasSearched,
    followError
  } = searchState;

const postScopeOptions = () => {
    if (!isLoggedInState.val) {
      return [
        { value: 'global', label: 'All Posts' },
        { value: 'seen', label: 'Seen Posts', disabled: true }
      ];
    }
    return [
      { value: 'global', label: 'All Posts' },
      { value: 'following', label: 'Following' },
      { value: 'seen', label: 'Seen Posts' }
    ];
  };

  const getFollowState = (userId, initialValue = false) => {
    if (!followStates[userId]) {
      followStates[userId] = van.state(Boolean(initialValue));
    } else if (followStates[userId].val !== Boolean(initialValue)) {
      followStates[userId].val = Boolean(initialValue);
    }
    return followStates[userId];
  };

  const getFollowBusyState = (userId) => {
    if (!followBusyStates[userId]) {
      followBusyStates[userId] = van.state(false);
    }
    return followBusyStates[userId];
  };

  const runPostsSearch = async ({ append = false } = {}) => {
    const currentQuery = String(query.val || '').trim();
    if (!currentQuery) {
      if (!append) {
        posts.val = [];
        postsHasMore.val = false;
        postsCursor.val = null;
      }
      return;
    }

    if (loadingPosts.val) return;

    loadingPosts.val = true;
    postsError.val = '';
    if (!append) {
      postsCursor.val = null;
      posts.val = [];
      postsHasMore.val = false;
    }

    try {
      const currentScope = postScope.val;
      const options = {
        q: currentQuery,
        limit: SEARCH_PAGE_SIZE,
        cursor: append ? postsCursor.val : null
      };
      const page = currentScope === 'following'
        ? await api.posts.getFeedPage(options)
        : await api.posts.getPage({
            ...options,
            ...(currentScope === 'global' ? {} : { scope: currentScope })
          });

      const results = Array.isArray(page?.items) ? page.items : [];
      const existingIds = new Set(append ? posts.val.map((post) => post.id) : []);
      const merged = append
        ? [...posts.val, ...results.filter((post) => !existingIds.has(post.id))]
        : results;

      posts.val = merged;
      postsCursor.val = page?.nextCursor || null;
      postsHasMore.val = !!page?.hasMore;
    } catch (error) {
      postsError.val = error?.message || 'Post search failed';
    } finally {
      loadingPosts.val = false;
      hasSearched.val = true;
    }
  };

  const runUsersSearch = async () => {
    const currentQuery = String(query.val || '').trim();
    if (!currentQuery) {
      users.val = [];
      return;
    }

    if (loadingUsers.val) return;

    loadingUsers.val = true;
    usersError.val = '';

    try {
      const result = await api.users.search(currentQuery, {
        includeFollowing: true
      });
      const list = Array.isArray(result) ? result : [];
      list.forEach((user) => {
        if (user?.id != null) {
          getFollowState(user.id, Boolean(user.is_following));
        }
      });
      users.val = list;
    } catch (error) {
      usersError.val = error?.message || 'User search failed';
      users.val = [];
    } finally {
      loadingUsers.val = false;
      hasSearched.val = true;
    }
  };

  const runSearch = () => {
    postsError.val = '';
    usersError.val = '';
    followError.val = '';
    if (activeTab.val === 'posts') {
      runPostsSearch({ append: false });
    } else {
      runUsersSearch();
    }
  };

  const handleQueryInput = (value) => {
    query.val = value;
    hasSearched.val = false;
    posts.val = [];
    users.val = [];

    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      runSearch();
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleTabChange = (tab) => {
    if (activeTab.val === tab) return;
    activeTab.val = tab;
    postsError.val = '';
    usersError.val = '';
    followError.val = '';
    posts.val = [];
    users.val = [];
    postsCursor.val = null;
    postsHasMore.val = false;
    hasSearched.val = false;
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }
    if (String(query.val || '').trim()) {
      runSearch();
    }
  };

  const handleScopeChange = (scopeValue) => {
    if (postScope.val === scopeValue) return;
    postScope.val = scopeValue;
    posts.val = [];
    postsCursor.val = null;
    postsHasMore.val = false;
    hasSearched.val = false;
    if (String(query.val || '').trim()) {
      runPostsSearch({ append: false });
    }
  };

  const handleLoadMorePosts = () => {
    if (!postsHasMore.val || loadingPosts.val) return;
    runPostsSearch({ append: true });
  };

  const handleFollowToggle = async (user) => {
    if (!isLoggedInState.val) {
      window.location.hash = '#login';
      return;
    }

    const followingState = getFollowState(user.id, false);
    const busyState = getFollowBusyState(user.id);

    if (busyState.val) return;

    busyState.val = true;
    followError.val = '';

    try {
      if (followingState.val) {
        await api.users.unfollow(user.id);
        followingState.val = false;
      } else {
        await api.users.follow(user.id);
        followingState.val = true;
      }
    } catch (error) {
      followError.val = error?.message || 'Unable to update follow status.';
      followingState.val = !followingState.val;
    } finally {
      busyState.val = false;
    }
  };

  const renderUserRow = (user) => {
    const followingState = getFollowState(user.id, user.is_following);
    const busyState = getFollowBusyState(user.id);

    return div({ class: "search-user-row" }, [
      a({
        class: "search-user-link",
        href: `#user/${user.id}`,
        onclick: (e) => {
          e.preventDefault();
          window.location.hash = `#user/${user.id}`;
        }
      }, [
        div({ class: "search-user-avatar" }, String(user.username?.[0] || '?').toUpperCase()),
        div({ class: "search-user-main" }, [
          span({ class: "search-user-name" }, user.username),
          span({ class: "search-user-id" }, `ID ${user.id}`)
        ])
      ]),
      button({
        class: () => `search-follow-btn ${followingState.val ? 'following' : 'not-following'}`,
        onclick: () => handleFollowToggle(user),
        disabled: () => busyState.val
      }, () => busyState.val ? "..." : (followingState.val ? "Unfollow" : "Follow"))
    ]);
  };

  const renderPosts = () => {
    const currentQuery = String(query.val || '').trim();
    const hasPosts = posts.val.length > 0;
    if (!currentQuery) {
      return p({ class: "search-hint" }, 'Type a term to search posts.');
    }
    if (loadingPosts.val && !hasPosts) {
      return div({ class: "loading" }, 'Searching posts...');
    }
    if (postsError.val) {
      return div({ class: "error" }, postsError.val);
    }
    if (!hasPosts && hasSearched.val) {
      return p({ class: "search-empty" }, 'No posts found.');
    }
    if (!hasPosts) return null;
    return div({ class: "search-post-results" }, [
      ...posts.val.map((post) => div({ class: "search-post-result" }, PostItem({ post }))),
      () => postsHasMore.val
        ? button({
            class: "search-load-more",
            onclick: handleLoadMorePosts,
            disabled: loadingPosts.val
          }, loadingPosts.val ? 'Loading…' : 'Load More')
        : null
    ]);
  };

  const renderUsers = () => {
    const currentQuery = String(query.val || '').trim();
    const hasUsers = users.val.length > 0;
    if (!isLoggedInState.val) {
      return p({ class: "search-hint" }, 'Sign in to search users.');
    }
    if (!currentQuery) {
      return p({ class: "search-hint" }, 'Type a term to search people.');
    }
    if (loadingUsers.val && !hasUsers) {
      return div({ class: "loading" }, 'Searching users...');
    }
    if (usersError.val) {
      return div({ class: "error" }, usersError.val);
    }
    if (!hasUsers && hasSearched.val) {
      return p({ class: "search-empty" }, 'No users found.');
    }
    return div({ class: "search-user-list" }, users.val.map(renderUserRow));
  };

  return div({ class: "search-page" }, [
    h2("Search"),
    div({ class: "search-toolbar" }, [
      div({ class: "search-tab-row" }, [
        button({
          type: "button",
          class: () => `search-tab ${activeTab.val === 'posts' ? 'active' : ''}`,
          onclick: () => handleTabChange('posts')
        }, "Posts"),
        button({
          type: "button",
          class: () => `search-tab ${activeTab.val === 'users' ? 'active' : ''}`,
          onclick: () => handleTabChange('users')
        }, "Users")
      ]),
      input({
        class: "search-input",
        type: "search",
        placeholder: activeTab.val === 'posts' ? "Search posts..." : "Search people...",
        value: query,
        oninput: (e) => handleQueryInput(e.target.value),
        onclear: () => {
          query.val = '';
          runSearch();
        }
      })
    ]),

    () => activeTab.val === 'posts'
      ? div({ class: "search-scope-row" }, [
          ...postScopeOptions().map(option => button({
            type: "button",
            disabled: () => option.disabled,
            title: () => option.disabled ? 'Sign in to see seen posts' : '',
            class: () => `search-scope ${postScope.val === option.value ? 'active' : ''}`,
            onclick: () => {
              if (option.disabled) return;
              handleScopeChange(option.value);
            }
          }, option.label))
        ])
      : null,

    div({ class: "search-result-area" }, [
      () => followError.val ? div({ class: "error" }, followError.val) : null,
      () => activeTab.val === 'posts' ? renderPosts() : renderUsers()
    ])
  ]);
}
