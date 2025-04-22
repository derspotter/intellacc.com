import van from 'vanjs-core';
import { initializeStore } from './store';
import { checkAuth } from './services/auth';
import { initializeSocket } from './services/socket';
import Router from './router';

// Initialize store
initializeStore();

// Check authentication
checkAuth();

// Initialize socket for real-time features
initializeSocket();

// Mount the application
document.addEventListener('DOMContentLoaded', () => {
  const appEl = document.getElementById('app');
  appEl.innerHTML = ""; // Clear container
  
  // Mount router
  van.add(appEl, Router());
  
  // Handle hash changes
  window.addEventListener('hashchange', () => {
    if (window.updatePageFromHash) {
      window.updatePageFromHash();
    }
  });
});