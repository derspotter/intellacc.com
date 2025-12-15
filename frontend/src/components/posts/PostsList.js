import van from 'vanjs-core';
import postsStore from '../../store/posts';  // Import the store object directly
import PostItem from './PostItem';

/**
 * List of posts component
 */
export default function PostsList() {
  // Create reference to state
  const posts = postsStore.state.posts;
  const loading = postsStore.state.loading;
  const error = postsStore.state.error;
  
  // Fetch posts if needed (similar to PredictionsList approach)
  // Check initialFetchAttempted to prevent infinite loop when posts are legitimately empty
  if (posts.val.length === 0 && !loading.val && !postsStore.state.initialFetchAttempted.val) {
    console.log('PostsList: Fetching posts data');
    setTimeout(() => postsStore.actions.fetchPosts.call(postsStore), 0);
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
  
  const renderEmptyMessage = () => {
    if (!loading.val && !error.val && posts.val.length === 0) {
      return van.tags.div({ class: "empty-list" }, "No posts yet.");
    }
    return null;
  };
  
  // The critical function that renders the posts
  const renderPosts = () => {
    if (posts.val.length > 0) {
      // Very important: Wrap posts in a div container instead of returning an array
      // and memoize each PostItem so it only re-renders when its specific post changes
      return van.tags.div({ class: "posts-container" },
        posts.val.map(post => {
          // We're still going to create a new post item each time - let Van handle updates
          // This way when store state changes, just that specific post will update
          return PostItem({ post });
        })
      );
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