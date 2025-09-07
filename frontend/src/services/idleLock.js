// frontend/src/services/idleLock.js
// Auto-lock private key after inactivity

import keyManager from './keyManager.js';

let idleTimer = null;
let timeoutMs = 15 * 60 * 1000; // default 15 minutes

function resetTimer() {
  if (!timeoutMs) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    try {
      keyManager.lockKeys();
      // Optionally notify user via a custom event
      document.dispatchEvent(new CustomEvent('keys-locked'));
    } catch {}
  }, timeoutMs);
}

export function configureIdleAutoLock(minutes) {
  const m = parseInt(minutes, 10);
  timeoutMs = isNaN(m) || m <= 0 ? 0 : m * 60 * 1000;
  try { localStorage.setItem('idleLockMinutes', String(m)); } catch {}
  resetTimer();
}

export function initIdleAutoLock() {
  // Load config from storage
  try {
    const saved = parseInt(localStorage.getItem('idleLockMinutes') || '15', 10);
    if (!isNaN(saved) && saved > 0) timeoutMs = saved * 60 * 1000; else timeoutMs = 0;
  } catch {}

  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll', 'focus'].forEach(evt => {
    window.addEventListener(evt, resetTimer, { passive: true });
  });
  resetTimer();
}
