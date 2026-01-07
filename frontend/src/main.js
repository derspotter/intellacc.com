import van from 'vanjs-core';
import { initializeStore } from './store';
import { checkAuth, isLoggedInState } from './services/auth';
import { initializeSocket } from './services/socket';
import { initIdleAutoLock } from './services/idleLock';
import { registerServiceWorker } from './services/pushService';
import Router, { updatePageFromHash } from './router';

// Initialize store before anything else
initializeStore();

// Check authentication status early
checkAuth();

// If logged in, start idle auto-lock
if (isLoggedInState.val) {
  initIdleAutoLock();
}

// Initialize socket for real-time features (can be done lazily)
setTimeout(() => {
  initializeSocket();
}, 100);

// Register service worker for push notifications
registerServiceWorker();

// Mount the application
document.addEventListener('DOMContentLoaded', () => {
  const appEl = document.getElementById('app');
  appEl.innerHTML = ""; // Clear container
  
  // Mount router
  van.add(appEl, Router());

  // Perform initial page load based on hash AFTER router is mounted
  updatePageFromHash();
  
  // Handle subsequent hash changes
  window.addEventListener('hashchange', updatePageFromHash);
});