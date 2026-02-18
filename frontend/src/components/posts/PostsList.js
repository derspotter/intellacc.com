import van from 'vanjs-core';
import postsStore from '../../store/posts';  // Import the store object directly
import PostItem from './PostItem';
import { isLoggedInState } from '../../services/auth';

let feedHoverController = null;

/**
 * List of posts component
 */
export default function PostsList() {
  const canVirtualize = typeof ResizeObserver !== 'undefined' && typeof requestAnimationFrame !== 'undefined';

  class Fenwick {
    constructor(n) {
      this.n = n;
      this.bit = new Array(n + 1).fill(0);
    }
    static fromArray(arr) {
      const f = new Fenwick(arr.length);
      for (let i = 0; i < arr.length; i++) f.add(i, arr[i]);
      return f;
    }
    add(idx0, delta) {
      for (let i = idx0 + 1; i <= this.n; i += i & -i) this.bit[i] += delta;
    }
    sumPrefix(idx0Exclusive) {
      let res = 0;
      for (let i = idx0Exclusive; i > 0; i -= i & -i) res += this.bit[i];
      return res;
    }
    total() {
      return this.sumPrefix(this.n);
    }
    // Smallest index (0-based) where prefix sum >= target. Returns n if target > total.
    lowerBound(target) {
      if (target <= 0) return 0;
      let idx = 0;
      let bitMask = 1;
      while (bitMask << 1 <= this.n) bitMask <<= 1;
      let sum = 0;
      for (let k = bitMask; k !== 0; k >>= 1) {
        const next = idx + k;
        if (next <= this.n && sum + this.bit[next] < target) {
          sum += this.bit[next];
          idx = next;
        }
      }
      return Math.min(idx, this.n); // idx is count of items strictly below target
    }
  }

  // Create reference to state
  const posts = postsStore.state.posts;
  const loading = postsStore.state.loading;
  const loadingMore = postsStore.state.loadingMore;
  const error = postsStore.state.error;
  const hasMore = postsStore.state.hasMore;

  const range = van.state({ start: 0, end: -1 });
  const topPad = van.state(0);
  const bottomPad = van.state(0);
  const searchQuery = postsStore.state.searchQuery;
  const searchScope = postsStore.state.searchScope;

  const DEFAULT_ITEM_H = 260;
  const OVERSCAN_PX = 1200;
  const PREFETCH_PX = 1800;

  const measuredById = new Map();
  let heightsByIndex = [];
  let idToIndex = new Map();
  let fenwick = Fenwick.fromArray([]);
  let rootEl = null;
  let rafPending = false;
  let resizeObserver = null;
  let observed = new Set();
  let observePending = false;
  let searchTimeout = null;
  // Keep a stable virtual list root element. Replacing the root on the first scroll
  // can cause Firefox to "snap back" to the top while it recomputes scroll metrics.
  const virtualTopSpacerEl = canVirtualize ? van.tags.div({ class: 'posts-spacer posts-spacer-top' }) : null;
  const virtualItemsEl = canVirtualize ? van.tags.div({ class: 'posts-virtual-items' }) : null;
  const virtualBottomSpacerEl = canVirtualize ? van.tags.div({ class: 'posts-spacer posts-spacer-bottom' }) : null;
  const virtualLoadingMoreEl = canVirtualize ? van.tags.div({ class: 'loading', style: 'display:none' }, 'Loading more...') : null;
  const virtualEndEl = canVirtualize ? van.tags.div({ class: 'end-of-feed', style: 'display:none' }, 'End of feed') : null;
  const virtualRootEl = canVirtualize ? van.tags.div({
    class: 'posts-container posts-virtualized',
    id: 'posts-virtual-list'
  }, [
    virtualTopSpacerEl,
    virtualItemsEl,
    virtualBottomSpacerEl,
    virtualLoadingMoreEl,
    virtualEndEl
  ]) : null;
  const itemCache = new Map(); // postId -> stable wrapper element
  let lastVisibleIds = [];
  let lastStart = 0;
  let lastEnd = -1;
  let lastFirstId = null;

  const getOrCreateItemEl = (post) => {
    let el = itemCache.get(post.id);
    if (!el) {
      el = van.tags.div(
        { class: 'post-virtual-item', 'data-post-id': post.id },
        PostItem({ post })
      );
      el.__postRef = post;
      itemCache.set(post.id, el);
      return el;
    }
    // Keep attributes stable even if the element got moved in/out of the DOM.
    el.dataset.postId = String(post.id);
    if (el.__postRef !== post) {
      // If the store replaced the post object, refresh this item in-place.
      el.replaceChildren(PostItem({ post }));
      el.__postRef = post;
    }
    return el;
  };

  const getScopeOptions = () => {
    if (!isLoggedInState.val) {
      return [{ value: 'global', label: 'All Posts' }];
    }
    return [
      { value: 'global', label: 'All Posts' },
      { value: 'following', label: 'Following' },
      { value: 'seen', label: 'Seen Posts' }
    ];
  };

  const triggerSearch = ({ scope = null, q = null } = {}) => {
    const nextScope = scope !== null ? scope : searchScope.val;
    const nextQuery = q !== null ? q : searchQuery.val;

    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }

    postsStore.actions.fetchPosts.call(postsStore, {
      reset: true,
      scope: nextScope,
      q: nextQuery
    });
  };

  const onSearchInput = (value) => {
    postsStore.actions.setSearchQuery.call(postsStore, value);
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      triggerSearch();
    }, 350);
  };

  const onScopeChange = (scope) => {
    postsStore.actions.setSearchScope.call(postsStore, scope);
    triggerSearch({ scope });
  };

  const resetVisibleRange = (visiblePosts, start, end) => {
    virtualItemsEl.replaceChildren(...visiblePosts.map(getOrCreateItemEl));
    lastVisibleIds = visiblePosts.map(p => p.id);
    lastStart = start;
    lastEnd = end;
    lastFirstId = posts.val[0]?.id ?? null;
    scheduleObservedUpdate();
  };

  const updateVisibleRangeIncremental = (start, end) => {
    const list = posts.val;
    if (!list.length || end < start) {
      virtualItemsEl.replaceChildren();
      lastVisibleIds = [];
      lastStart = 0;
      lastEnd = -1;
      lastFirstId = list[0]?.id ?? null;
      scheduleObservedUpdate();
      return;
    }

    // If the list re-based (e.g., refresh inserted items at the top), fall back to a full reset.
    const currentFirstId = list[0]?.id ?? null;
    if (lastFirstId !== currentFirstId) {
      resetVisibleRange(list.slice(start, end + 1), start, end);
      return;
    }

    // First render.
    if (lastEnd < lastStart || lastVisibleIds.length === 0) {
      resetVisibleRange(list.slice(start, end + 1), start, end);
      return;
    }

    // If the range jumped too far, do a reset (cheaper than diffing).
    if (Math.abs(start - lastStart) > 50 || Math.abs(end - lastEnd) > 50) {
      resetVisibleRange(list.slice(start, end + 1), start, end);
      return;
    }

    // Remove from front.
    while (lastStart < start && lastVisibleIds.length) {
      const el = virtualItemsEl.firstElementChild;
      if (el) el.remove();
      lastVisibleIds.shift();
      lastStart++;
    }

    // Remove from back.
    while (lastEnd > end && lastVisibleIds.length) {
      const el = virtualItemsEl.lastElementChild;
      if (el) el.remove();
      lastVisibleIds.pop();
      lastEnd--;
    }

    // Prepend missing at front (iterate backwards so order is correct).
    for (let i = start - 1; i >= lastStart; i--) {
      const post = list[i];
      if (!post) continue;
      virtualItemsEl.prepend(getOrCreateItemEl(post));
      lastVisibleIds.unshift(post.id);
    }
    if (start < lastStart) lastStart = start;

    // Append missing at back.
    for (let i = lastEnd + 1; i <= end; i++) {
      const post = list[i];
      if (!post) continue;
      virtualItemsEl.append(getOrCreateItemEl(post));
      lastVisibleIds.push(post.id);
    }
    if (end > lastEnd) lastEnd = end;

    // Refresh content if post objects swapped, without touching DOM order.
    for (let i = 0; i < lastVisibleIds.length; i++) {
      const idx = lastStart + i;
      const post = list[idx];
      if (post) getOrCreateItemEl(post);
    }

    scheduleObservedUpdate();
  };

  const ensureFeedHover = () => {
    if (!canVirtualize || !virtualRootEl) return;
    // Mobile/touch devices do not have real hover. Avoid installing hover-based UX there
    // (touch scrolling/tapping can emit pointer events that would make this feel random).
    if (window.matchMedia && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    if (!feedHoverController) {
      feedHoverController = {
        root: null,
        openEl: null,
        pendingEl: null,
        timer: null,
        lastMouse: { x: 0, y: 0, valid: false }
      };

      // Track cursor position so we can keep hover state stable during scroll.
      window.addEventListener('mousemove', (e) => {
        feedHoverController.lastMouse = { x: e.clientX, y: e.clientY, valid: true };
      }, { passive: true });

      // Some browsers may drop :hover while the page is actively scrolling.
      // If the cursor is still over the expanded overlay, keep it open.
      window.addEventListener('scroll', () => {
        const c = feedHoverController;
        if (!c.openEl) return;
        if (!c.lastMouse.valid) return;
        const el = document.elementFromPoint(c.lastMouse.x, c.lastMouse.y);
        const stillOver = !!(el && el.closest && el.closest('.post-content-text, .post-content-hover-overlay') && c.openEl.contains(el));
        if (!stillOver) {
          c.openEl.classList.remove('hover-open');
          c.openEl = null;
        }
      }, { passive: true });
    }

    feedHoverController.root = virtualRootEl;
    if (virtualRootEl.__hoverDelegationInstalled) return;
    virtualRootEl.__hoverDelegationInstalled = true;

    const getPostContentElFromNode = (node) => {
      if (!node || !node.closest) return null;
      // Trigger zone should be the clamped text itself, or the expanded overlay.
      const zone = node.closest('.post-content-text, .post-content-hover-overlay');
      if (!zone) return null;
      const el = zone.closest('.post-content.clamped.has-hover-overlay');
      if (!el) return null;
      if (!virtualRootEl.contains(el)) return null;
      return el;
    };

    const clearTimer = () => {
      const c = feedHoverController;
      if (c.timer) {
        clearTimeout(c.timer);
        c.timer = null;
      }
      c.pendingEl = null;
    };

    const openAfterDelay = (el) => {
      const c = feedHoverController;
      clearTimer();
      c.pendingEl = el;
      c.timer = setTimeout(() => {
        // Still the current target?
        if (c.pendingEl !== el) return;
        if (c.openEl && c.openEl !== el) c.openEl.classList.remove('hover-open');
        c.openEl = el;
        el.classList.add('hover-open');
      }, 1000);
    };

    const closeIfMatches = (el) => {
      const c = feedHoverController;
      if (c.openEl === el) {
        el.classList.remove('hover-open');
        c.openEl = null;
      }
    };

    // Delegate pointer enter/leave to avoid per-item listeners.
    virtualRootEl.addEventListener('pointerover', (e) => {
      const el = getPostContentElFromNode(e.target);
      if (!el) return;
      // Ignore transitions within the trigger zone of the same post.
      const toEl = getPostContentElFromNode(e.relatedTarget);
      if (toEl && toEl === el) return;
      openAfterDelay(el);
    });

    virtualRootEl.addEventListener('pointerout', (e) => {
      const el = getPostContentElFromNode(e.target);
      if (!el) return;
      const toEl = getPostContentElFromNode(e.relatedTarget);
      // If we're still inside the trigger zone of the same post, keep it open.
      if (toEl && toEl === el) return;
      clearTimer();
      closeIfMatches(el);
    });

    // Keep open/close precise even when moving within the post card:
    // if the cursor is no longer over text/overlay, collapse.
    virtualRootEl.addEventListener('pointermove', (e) => {
      const c = feedHoverController;
      if (!c.openEl) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const over = getPostContentElFromNode(el);
      if (over !== c.openEl) {
        c.openEl.classList.remove('hover-open');
        c.openEl = null;
      }
    }, { passive: true });
  };

  // Fetch posts if needed (similar to PredictionsList approach)
  // Check initialFetchAttempted to prevent infinite loop when posts are legitimately empty
  if (posts.val.length === 0 && !loading.val && !postsStore.state.initialFetchAttempted.val) {
    console.log('PostsList: Fetching posts data');
    setTimeout(() => postsStore.actions.fetchPosts.call(postsStore, { reset: true }), 0);
  }

  const rebuildIndex = () => {
    idToIndex = new Map();
    heightsByIndex = posts.val.map((p, i) => {
      idToIndex.set(p.id, i);
      const m = measuredById.get(p.id);
      return Number.isFinite(m) ? m : DEFAULT_ITEM_H;
    });
    fenwick = Fenwick.fromArray(heightsByIndex);
  };

  const updateMeasurement = (postId, newH) => {
    const idx = idToIndex.get(postId);
    if (idx === undefined) return;
    const h = Math.max(80, Math.round(newH));
    const old = heightsByIndex[idx];
    if (Math.abs(old - h) < 2) return;
    heightsByIndex[idx] = h;
    measuredById.set(postId, h);
    fenwick.add(idx, h - old);
  };

  const updateObserved = () => {
    if (!rootEl) rootEl = virtualRootEl || document.getElementById('posts-virtual-list');
    if (!rootEl || !rootEl.isConnected || !resizeObserver) return;
    // Only observe currently-rendered items.
    // Avoid forced layout reads (offsetHeight) on scroll; ResizeObserver will report sizes.
    observed.forEach(el => resizeObserver.unobserve(el));
    observed = new Set();
    rootEl.querySelectorAll('.post-virtual-item').forEach(el => {
      observed.add(el);
      resizeObserver.observe(el);
    });
  };

  const scheduleObservedUpdate = () => {
    if (observePending) return;
    observePending = true;
    // Defer until after DOM updates settle.
    requestAnimationFrame(() => {
      setTimeout(() => {
        observePending = false;
        updateObserved();
      }, 0);
    });
  };

  const updateRange = () => {
    if (!rootEl) rootEl = virtualRootEl || document.getElementById('posts-virtual-list');
    if (!rootEl || !rootEl.isConnected) return;
    const total = fenwick.total();
    const rectTop = rootEl.getBoundingClientRect().top + window.scrollY;
    const within = window.scrollY - rectTop;
    const viewH = window.innerHeight;

    const startOffset = Math.max(0, within - OVERSCAN_PX);
    const endOffset = Math.max(0, within + viewH + OVERSCAN_PX);

    let start = fenwick.lowerBound(startOffset);
    let end = fenwick.lowerBound(endOffset);
    if (end < posts.val.length - 1) end += 3;
    start = Math.max(0, Math.min(posts.val.length - 1, start));
    end = Math.max(start, Math.min(posts.val.length - 1, end));

    topPad.val = fenwick.sumPrefix(start);
    bottomPad.val = Math.max(0, total - fenwick.sumPrefix(end + 1));

    // Avoid re-rendering the entire virtual list when the range didn't change.
    // `range` is an object state, and assigning a new object triggers replacement.
    const prev = range.val;
    const rangeChanged = !prev || prev.start !== start || prev.end !== end;
    if (!prev || prev.start !== start || prev.end !== end) {
      range.val = { start, end };
    }

    // Prefetch more when approaching the bottom of the currently-known list.
    if (hasMore.val && !loadingMore.val && !loading.val) {
      if (within + viewH + PREFETCH_PX > total) {
        postsStore.actions.fetchMorePosts.call(postsStore);
      }
    }

    // Only refresh observation set when the rendered range changes.
    if (rangeChanged) scheduleObservedUpdate();
  };

  const scheduleUpdate = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateRange();
    });
  };

  // Init observers/listeners once per component instance.
  setTimeout(() => {
    if (!canVirtualize) return;
    if (resizeObserver) return;
    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const el = entry.target;
        const id = Number(el.dataset.postId);
        if (Number.isInteger(id)) updateMeasurement(id, entry.contentRect.height);
      }
      scheduleUpdate();
    });
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
  }, 0);

  van.derive(() => {
    // Rebuild on list changes and refresh the range.
    posts.val.length;
    rebuildIndex();
    scheduleUpdate();
    // New list means new DOM nodes; ensure they're observed once rendered.
    scheduleObservedUpdate();
  });

  // Sync the stable virtual root without recreating it (prevents first-scroll snap-back).
  if (canVirtualize && virtualRootEl) {
    // Install once per root instance.
    setTimeout(ensureFeedHover, 0);

    van.derive(() => {
      const top = topPad.val;
      const bottom = bottomPad.val;
      const lm = loadingMore.val;
      const hm = hasMore.val;

      virtualTopSpacerEl.style.height = `${top}px`;
      virtualBottomSpacerEl.style.height = `${bottom}px`;
      virtualLoadingMoreEl.style.display = lm ? 'block' : 'none';
      virtualEndEl.style.display = (!hm && posts.val.length > 0) ? 'block' : 'none';
    });

    // Update visible items only when the visible range changes.
    // This keeps hover state stable (no DOM replacement during the 1s hover delay).
    van.derive(() => {
      const { start, end } = range.val;
      // Touch posts to rerun when list changes.
      posts.val.length;
      updateVisibleRangeIncremental(start, end);
    });
  }

  // Define the rendering functions separately for clarity
  const renderLoading = () => {
    if (loading.val) return van.tags.div({ class: "loading" }, "Loading posts...");
    return null;
  };
  
  const renderError = () => {
    if (error.val) return van.tags.div({ class: "error" }, error.val);
    return null;
  };
  
  const renderSearchBar = () => {
    const scopeOptions = getScopeOptions();
    const activeScope = isLoggedInState.val ? searchScope.val : 'global';

    return van.tags.div({ class: "posts-search-controls", style: "margin: 8px 0 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;" }, [
      van.tags.div({ style: "display:flex; flex: 1; min-width: 210px; gap: 8px; align-items:center;" }, [
        van.tags.label({ style: "font-size: 0.9rem; color: #555;" }, "Search"),
        van.tags.input({
          type: "text",
          value: searchQuery,
          placeholder: "Search posts and authors",
          oninput: e => onSearchInput(e.target.value),
          style: "flex: 1; min-width: 160px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px;"
        })
      ]),
      van.tags.div({ style: "display:flex; gap: 6px; flex-wrap: wrap;" }, scopeOptions.map(option => {
        const isActive = option.value === activeScope;
        return van.tags.button({
          type: "button",
          onclick: () => onScopeChange(option.value),
          style: `padding: 7px 12px; border-radius: 999px; border: 1px solid ${isActive ? '#2d80ff' : '#ccc'}; background: ${isActive ? '#2d80ff' : 'white'}; color: ${isActive ? 'white' : '#222'}; cursor: pointer;`
        }, option.label);
      }))
    ]);
  };

  const renderEmptyMessage = () => {
    if (!loading.val && !error.val && posts.val.length === 0) {
      return van.tags.div({ class: "empty-list" }, "No posts yet.");
    }
    return null;
  };
  
  // The critical function that renders the posts
  const renderPosts = () => {
    if (posts.val.length > 0) {
      if (!canVirtualize) {
        return van.tags.div({ class: "posts-container" },
          posts.val.map(post => PostItem({ post }))
        );
      }
      return virtualRootEl;
    }
    return null;
  };
  
  // Render the component
  return van.tags.div({ class: "posts-list" }, [
    renderSearchBar,
    renderLoading,
    renderError,
    renderEmptyMessage,
    renderPosts
  ]);

}
