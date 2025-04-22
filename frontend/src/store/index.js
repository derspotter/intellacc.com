// Import directly from the modules folder
import navigationStore from './navigation';
import postsStore from './posts'; 
import predictionsStore from './predictions';
import userStore from './user';

/**
 * Initialize all stores and make global
 */
export function initializeStore() {
  // Bind the method to ensure proper "this" context
  const boundUpdatePageFromHash = navigationStore.actions.updatePageFromHash.bind(navigationStore);
  
  // Listen for hash changes with the bound function
  window.addEventListener('hashchange', boundUpdatePageFromHash);
  
  // Make the same bound function available globally
  window.updatePageFromHash = boundUpdatePageFromHash;
  
  // Initial page update using the bound function
  boundUpdatePageFromHash();
  
  // Return store object
  return {
    posts: postsStore,
    predictions: predictionsStore,
    navigation: navigationStore,
    user: userStore
  };
}

// Create and export global store
const store = initializeStore();

// Re-export commonly used state for convenience
export const currentPageState = navigationStore.state.currentPage;
export const isViewReadyState = navigationStore.state.viewReady;
export const postsState = postsStore.state.posts;
export const loadingPostsState = postsStore.state.loading;

export default store;