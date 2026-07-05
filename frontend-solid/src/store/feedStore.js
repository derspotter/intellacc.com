import { createStore } from "solid-js/store";
import { api, getPostsPaging } from "../services/api";
import { getToken } from "../services/tokenService";

const PAGE_LIMIT = 20;

const [state, setState] = createStore({
    posts: [],
    hasMore: false,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null
});

let fetchEpoch = 0;

const appendUnique = (current, next) => {
    const seen = new Set(current.map(p => String(p.id)));
    return [...current, ...next.filter(p => !seen.has(String(p.id)))];
};

const fetchPage = async ({ reset }) => {
    if (!getToken()) {
        setState({ posts: [], hasMore: false, nextCursor: null, loading: false, loadingMore: false, error: null });
        return;
    }
    const epoch = ++fetchEpoch;
    setState(reset ? { loading: true, error: null } : { loadingMore: true, error: null });
    try {
        const cursor = reset ? null : state.nextCursor;
        const response = await api.posts.getPage({ cursor, limit: PAGE_LIMIT });
        if (epoch !== fetchEpoch) return; // superseded by a newer request
        const paging = getPostsPaging(response);
        setState({
            posts: reset ? paging.items : appendUnique(state.posts, paging.items),
            hasMore: paging.hasMore,
            nextCursor: paging.nextCursor,
            loading: false,
            loadingMore: false
        });
    } catch (err) {
        if (epoch !== fetchEpoch) return;
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

const clear = () => {
    setState({ posts: [], hasMore: false, nextCursor: null, loading: false, loadingMore: false, error: null });
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
    clear
};
