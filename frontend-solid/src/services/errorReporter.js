import { getToken } from './tokenService';

// Self-hosted error tracking: ships uncaught errors and unhandled rejections
// to POST /api/errors (30/hour/IP server-side; digest mail daily). Prod-only,
// deduped per message, capped per page load so a render loop can't flood.
const MAX_REPORTS_PER_LOAD = 10;
const seen = new Set();
let sent = 0;

const report = (message, stack) => {
  if (!import.meta.env.PROD) return;
  if (!message || sent >= MAX_REPORTS_PER_LOAD) return;

  const key = String(message).slice(0, 200);
  if (seen.has(key)) return;
  seen.add(key);
  sent += 1;

  try {
    const token = getToken();
    fetch('/api/errors', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        stack: stack ? String(stack).slice(0, 4000) : null,
        url: window.location.href.slice(0, 300)
      })
    }).catch(() => {});
  } catch {
    // The reporter must never throw.
  }
};

export function initErrorReporter() {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    // Resource-load errors (img/script) have no message; skip them.
    if (!event.message) return;
    report(event.message, event.error?.stack);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    report(
      reason?.message || (typeof reason === 'string' ? reason : 'Unhandled rejection'),
      reason?.stack
    );
  });
}
