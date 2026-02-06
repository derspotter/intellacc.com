import van from 'vanjs-core';
import postsStore from '../../store/posts';  // Import the store object directly
import PostItem from './PostItem';

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
    if (!rootEl) rootEl = document.getElementById('posts-virtual-list');
    if (!rootEl || !resizeObserver) return;
    // Only observe currently-rendered items.
    observed.forEach(el => resizeObserver.unobserve(el));
    observed = new Set();
    rootEl.querySelectorAll('.post-virtual-item').forEach(el => {
      observed.add(el);
      resizeObserver.observe(el);
      const id = Number(el.dataset.postId);
      if (Number.isInteger(id)) updateMeasurement(id, el.offsetHeight);
    });
  };

  const updateRange = () => {
    if (!rootEl) rootEl = document.getElementById('posts-virtual-list');
    if (!rootEl) return;
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
    range.val = { start, end };

    // Prefetch more when approaching the bottom of the currently-known list.
    if (hasMore.val && !loadingMore.val && !loading.val) {
      if (within + viewH + PREFETCH_PX > total) {
        postsStore.actions.fetchMorePosts.call(postsStore);
      }
    }

    // Defer measurement updates to after DOM settles.
    setTimeout(updateObserved, 0);
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
  });

  // Define the rendering functions separately for clarity
  const renderLoading = () => {
    if (loading.val) return van.tags.div({ class: "loading" }, "Loading posts...");
    return null;
  };
  
  const renderError = () => {
    if (error.val) return van.tags.div({ class: "error" }, error.val);
    return null;
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

      const { start, end } = range.val;
      const visible = posts.val.slice(start, end + 1);
      return van.tags.div({
        class: "posts-container posts-virtualized",
        id: 'posts-virtual-list'
      }, [
        van.tags.div({ class: 'posts-spacer posts-spacer-top', style: () => `height:${topPad.val}px` }),
        ...visible.map(post =>
          van.tags.div({ class: 'post-virtual-item', 'data-post-id': post.id }, PostItem({ post }))
        ),
        van.tags.div({ class: 'posts-spacer posts-spacer-bottom', style: () => `height:${bottomPad.val}px` }),
        () => loadingMore.val ? van.tags.div({ class: 'loading' }, 'Loading more...') : null,
        () => (!hasMore.val && posts.val.length > 0) ? van.tags.div({ class: 'end-of-feed' }, 'End of feed') : null
      ]);
    }
    return null;
  };
  
  // Render the component
  return van.tags.div({ class: "posts-list" }, [
    renderLoading,
    renderError,
    renderEmptyMessage,
    renderPosts
  ]);

}
