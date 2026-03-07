/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import './styles.css'
import { initializeSkinProvider } from './services/skinProvider'
import App from './App.jsx'

const root = document.getElementById('root')

const RUNTIME_RESET_KEY = 'solid_runtime_reset_v1';

const waitForWindowLoad = async () => {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'complete') return;
  await new Promise((resolve) => {
    window.addEventListener('load', resolve, { once: true });
  });
};

const waitForInitialLayoutStability = async () => {
  await waitForWindowLoad();

  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {}
  }

  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
};

const resetLegacyRuntimeState = async () => {
  if (typeof window === 'undefined') return;
  if (window.location.hostname !== 'intellacc.com') return;
  if (window.localStorage?.getItem(RUNTIME_RESET_KEY) === 'done') return;

  try {
    if ('caches' in window) {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((key) => caches.delete(key)));
    }

    window.localStorage?.setItem(RUNTIME_RESET_KEY, 'done');
  } catch (error) {
    console.warn('[runtime-reset] failed to clear legacy runtime state', error);
  }
};

const ensureCoreServiceWorker = async () => {
  if (typeof window === 'undefined') return null;
  if (!('serviceWorker' in navigator)) return null;

  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return null;
  }

  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (error) {
    console.warn('[runtime-reset] failed to ensure service worker registration', error);
    return null;
  }
};

initializeSkinProvider();
Promise.resolve(resetLegacyRuntimeState())
  .catch(() => null)
  .then(() => ensureCoreServiceWorker())
  .catch(() => null)
  .then(() => waitForInitialLayoutStability())
  .finally(() => {
    render(() => <App />, root);
  });
