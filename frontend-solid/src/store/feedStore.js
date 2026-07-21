import { createStore } from "solid-js/store";
import { api, getPostsPaging } from "../services/api";
import { getToken } from "../services/tokenService";
import { createEpochGuard } from "../lib/requestEpoch";

const PAGE_LIMIT = 20;

const [state, setState] = createStore({
    posts: [],
    hasMore: false,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    usingFeed: true,
    discoverMode: false
});

const guard = createEpochGuard();

const appendUnique = (current, next) => {
    const seen = new Set(current.map(p => String(p.id)));
    return [...current, ...next.filter(p => !seen.has(String(p.id)))];
};

const fetchPage = async ({ reset }) => {
    if (!getToken()) {
        setState({ posts: [], hasMore: false, nextCursor: null, loading: false, loadingMore: false, error: null, usingFeed: false, discoverMode: false });
        return;
    }
    const token = guard.begin();
    if (reset) setState('usingFeed', Boolean(getToken()));
    setState(reset ? { loading: true, error: null } : { loadingMore: true, error: null });
    try {
        const cursor = reset ? null : state.nextCursor;
        let response;
        let usingFeed = state.usingFeed;
        if (usingFeed) {
            try {
                response = await api.posts.getFeedPage({ cursor, limit: PAGE_LIMIT });
            } catch (err) {
                const msg = String(err?.message || '');
                if (reset && (msg.includes('401') || msg.includes('403'))) {
                    usingFeed = false;
                    response = await api.posts.getPage({ cursor, limit: PAGE_LIMIT });
                } else {
                    throw err;
                }
            }
        } else {
            response = await api.posts.getPage({ cursor, limit: PAGE_LIMIT });
        }
        if (!guard.isCurrent(token)) return; // superseded by a newer request
        const paging = getPostsPaging(response);

        // Empty following-feed on reset: discover fallback (top predictors).
        if (reset && usingFeed && paging.items.length === 0) {
            try {
                const discover = await api.discover.feed();
                if (!guard.isCurrent(token)) return;
                const items = Array.isArray(discover?.items) ? discover.items : [];
                if (items.length > 0) {
                    setState({
                        posts: items, usingFeed, discoverMode: true,
                        hasMore: false, nextCursor: null,
                        loading: false, loadingMore: false
                    });
                    return;
                }
            } catch (err) {
                console.error('Discover fallback failed', err);
            }
            if (!guard.isCurrent(token)) return; // superseded while discover was in flight
        }

        setState({
            posts: reset ? paging.items : appendUnique(state.posts, paging.items),
            hasMore: paging.hasMore,
            nextCursor: paging.nextCursor,
            usingFeed,
            discoverMode: reset ? false : state.discoverMode,
            loading: false,
            loadingMore: false
        });
    } catch (err) {
        if (!guard.isCurrent(token)) return;
        console.error("Failed to load posts", err);
        setState({ error: err.message, loading: false, loadingMore: false });
    }
};

const loadPosts = () => fetchPage({ reset: true });

const loadMore = () => {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    return fetchPage({ reset: false });
};

const addPost = (post) => {
    // The backend broadcasts 'new_post' globally, including posts made in a
    // community group. Those belong on the group's feed, not the home feed.
    if (post?.community_group_id != null) return;
    setState("posts", (prev) => [post, ...prev]);
};

const updatePost = (post) => {
    setState("posts", (prev) =>
        prev.map(p => p.id === post.id ? { ...p, ...post } : p)
    );
};

const addComment = (comment) => {
    const postId = comment?.post_id;
    if (postId == null) return;

    const postIndex = state.posts.findIndex(p => String(p.id) === String(postId));
    if (postIndex === -1) return;

    setState("posts", postIndex, "comments", (prev) => {
        const existing = Array.isArray(prev) ? prev : [];
        if (comment?.id != null && existing.some(c => c.id === comment.id)) return existing;
        return [...existing, comment];
    });
};

const createPost = async (content, image_attachment_id = null, image_url = null, repost_id = null) => {
    const tempId = `temp-${Date.now()}`;
    const tempPost = {
        id: tempId,
        content: content || '',
        username: "You", // Placeholder until real post returns
        created_at: new Date().toISOString(),
        like_count: 0,
        liked_by_user: false,
        is_temp: true,
        repost_id
    };

    // Optimistic add
    setState("posts", (prev) => [tempPost, ...prev]);

    try {
        const newPost = await api.posts.create(content, image_attachment_id, image_url, repost_id);
        // Replace temp post with real one
        setState("posts", (prev) => prev.map(p => p.id === tempId ? newPost : p));
        return newPost;
    } catch (err) {
        // Revert optimistic add
        setState("posts", (prev) => prev.filter(p => p.id !== tempId));
        throw err;
    }
};

const likePost = (postId) => {
    if (postId == null) return;
    setState("posts", p => String(p.id) === String(postId), "liked_by_user", true);
    setState("posts", p => String(p.id) === String(postId), "like_count", c => (c || 0) + 1);
};

const unlikePost = (postId) => {
    if (postId == null) return;
    setState("posts", p => String(p.id) === String(postId), "liked_by_user", false);
    setState("posts", p => String(p.id) === String(postId), "like_count", c => Math.max(0, (c || 1) - 1));
};

// Optimistic repost marker on the SOURCE post (mirrors likePost/unlikePost).
// There is no unrepost endpoint; unrepostPost exists only as the error revert.
const repostPost = (postId) => {
    if (postId == null) return;
    setState("posts", p => String(p.id) === String(postId), "reposted_by_user", true);
    setState("posts", p => String(p.id) === String(postId), "repost_count", c => (c || 0) + 1);
};

const unrepostPost = (postId) => {
    if (postId == null) return;
    setState("posts", p => String(p.id) === String(postId), "reposted_by_user", false);
    setState("posts", p => String(p.id) === String(postId), "repost_count", c => Math.max(0, (c || 1) - 1));
};

const clear = () => {
    guard.invalidate(); // invalidate any in-flight fetch so it can't repopulate cleared state
    setState({ posts: [], hasMore: false, nextCursor: null, loading: false, loadingMore: false, error: null, usingFeed: true, discoverMode: false });
};

export const feedStore = {
    state,
    loadPosts,
    loadMore,
    addPost,
    updatePost,
    addComment,
    createPost,
    likePost,
    unlikePost,
    repostPost,
    unrepostPost,
    clear
};
