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

export const feedStore = {
    state,
    loadPosts,
    addPost
};
