import { createStore } from "solid-js/store";
import { api } from "../services/api";
import { getToken } from "../services/tokenService";

const [state, setState] = createStore({
    posts: [],
    loading: false,
    error: null
});

const loadPosts = async () => {
    // Skip fetch if not authenticated
    if (!getToken()) {
        setState({ posts: [], loading: false, error: null });
        return;
    }
    setState({ loading: true, error: null });
    try {
        const posts = await api.posts.getAll();
        setState({ posts: Array.isArray(posts) ? posts : [], loading: false });
    } catch (err) {
        console.error("Failed to load posts", err);
        setState({ error: err.message, loading: false });
    }
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

const createPost = async (content) => {
    const tempId = `temp-${Date.now()}`;
    const tempPost = {
        id: tempId,
        content,
        username: "You", // Placeholder until real post returns
        created_at: new Date().toISOString(),
        like_count: 0,
        liked_by_user: false,
        is_temp: true
    };

    // Optimistic add
    setState("posts", (prev) => [tempPost, ...prev]);

    try {
        const newPost = await api.posts.create(content);
        // Replace temp post with real one
        setState("posts", (prev) => prev.map(p => p.id === tempId ? newPost : p));
    } catch (err) {
        console.error("Failed to create post", err);
        // Remove temp post on error
        setState("posts", (prev) => prev.filter(p => p.id !== tempId));
        throw err;
    }
};

const likePost = (postId) => {
    if (postId == null) return;
    setState("posts", (prev) => prev.map(p =>
        String(p.id) === String(postId)
            ? { ...p, liked_by_user: true, like_count: (p.like_count || 0) + 1 }
            : p
    ));
};

const unlikePost = (postId) => {
    if (postId == null) return;
    setState("posts", (prev) => prev.map(p =>
        String(p.id) === String(postId)
            ? { ...p, liked_by_user: false, like_count: Math.max(0, (p.like_count || 1) - 1) }
            : p
    ));
};

const clear = () => {
    setState({ posts: [], loading: false, error: null });
};

export const feedStore = {
    state,
    loadPosts,
    addPost,
    updatePost,
    addComment,
    createPost,
    likePost,
    unlikePost,
    clear
};
