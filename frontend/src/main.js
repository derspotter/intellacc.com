import van from 'vanjs-core';
import { initializeStore } from './store';
import { checkAuth, isLoggedInState } from './services/auth';
import { initializeSocket } from './services/socket';
import keyManager from './services/keyManager.js';
import { bootstrapSignalIfNeeded } from './services/signalBootstrap.js';
import { initIdleAutoLock } from './services/idleLock';
import Router, { updatePageFromHash } from './router'; // Import updatePageFromHash

// Initialize store before anything else
initializeStore();

// Check authentication status early
checkAuth();

// If logged in, proactively initialize and ensure encryption keys in background
(async () => {
  try {
    if (isLoggedInState.val) {
      await keyManager.initialize();
      const r = await keyManager.ensureKeys();
      if (r && r.needsRepair) {
        console.warn('Keys need repair on this device. Not auto-repairing to avoid breaking other devices. Use Settings → Security to generate new keys on this device.');
      }
      // Start idle auto-lock when authenticated
      initIdleAutoLock();

      // Auto-bootstrap Signal (identity/prekeys) in background
      try { await bootstrapSignalIfNeeded(); } catch {}
    }
  } catch (e) {
    console.warn('Key bootstrap skipped/failed:', e?.message || e);
  }
})();

// Initialize socket for real-time features (can be done lazily)
setTimeout(() => {
  initializeSocket();
}, 100);

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
