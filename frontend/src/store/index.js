// src/store/index.js
import van from 'vanjs-core';
import navigationStore from './navigation';

// Only navigationStore is loaded eagerly (needed for all pages)
const stores = {
  navigation: navigationStore
};

// Create reactive state for loaded store modules
const loadedStores = van.state({
  navigation: navigationStore
});

/**
 * Get or load a specific store module
 * @param {string} storeName - Name of the store to load
 * @returns {Promise<Object>} - The store module
 */
export async function getStore(storeName) {
  // Return from cache if already loaded
  if (stores[storeName]) {
    return stores[storeName];
  }
  
  // Dynamically import the requested store
  try {
    switch(storeName) {
      case 'posts':
        stores.posts = (await import('./posts')).default;
        break;
      case 'predictions':
        stores.predictions = (await import('./predictions')).default;
        break;
      case 'user':
        stores.user = (await import('./user')).default;
        break;
      default:
        console.warn(`Unknown store module: ${storeName}`);
        return null;
    }
    
    // Update the reactive state
    loadedStores.val = {...loadedStores.val, [storeName]: stores[storeName]};
    return stores[storeName];
  } catch (error) {
    console.error(`Failed to load store module: ${storeName}`, error);
    return null;
  }
}

/**
 * Initialize navigation store only
 */
export function initializeStore() {
  const boundUpdatePageFromHash = navigationStore.actions.updatePageFromHash.bind(navigationStore);
  window.addEventListener('hashchange', boundUpdatePageFromHash);
  window.updatePageFromHash = boundUpdatePageFromHash;
  boundUpdatePageFromHash();
  
  return stores;
}

// Re-export commonly used state for convenience
export const currentPageState = navigationStore.state.currentPage;
export const isViewReadyState = navigationStore.state.viewReady;

// Export loadedStores state and getter function
export { loadedStores };
export default stores;