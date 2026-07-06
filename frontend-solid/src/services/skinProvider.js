import { createSignal } from 'solid-js';
import { api } from './api';

const VALID_SKINS = ['van', 'terminal'];
const DEFAULT_SKIN = 'van';
const STORAGE_KEY = 'intellacc.ui.skin';

const isValidSkin = (skin) => VALID_SKINS.includes(skin);

const parseSkinFromHash = () => {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash || '';
  const hashPayload = hash.startsWith('#') ? hash.slice(1) : hash;
  const [, hashQuery] = hashPayload.split('?');
  if (!hashQuery) return null;

  const params = new URLSearchParams(hashQuery);
  const skin = params.get('skin');
  return isValidSkin(skin) ? skin : null;
};

const parseSkinFromQuery = () => {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search || '');
  const skin = params.get('skin');
  return isValidSkin(skin) ? skin : null;
};

const readStoredSkin = () => {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  return isValidSkin(stored) ? stored : null;
};

const writeStoredSkin = (skin) => {
  if (typeof window === 'undefined') return;
  if (isValidSkin(skin)) {
    localStorage.setItem(STORAGE_KEY, skin);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
};

const [skinState, setSkinState] = createSignal(DEFAULT_SKIN);

const applySkinClass = (skin) => {
  if (typeof document === 'undefined') return;

  VALID_SKINS.forEach((name) => {
    document.body.classList.remove(`skin-${name}`);
  });
  document.body.classList.add(`skin-${skin}`);
  document.body.dataset.skin = skin;
};

const applyActiveSkin = (querySkin, storedSkin) => {
  const nextSkin = querySkin || storedSkin || DEFAULT_SKIN;
  setSkinState(nextSkin);
  applySkinClass(nextSkin);
  return nextSkin;
};

let initialized = false;

export const resolveSkin = () => {
  const querySkin = parseSkinFromQuery() || parseSkinFromHash();
  // Default to Van on direct visits unless a URL skin is explicitly requested.
  return querySkin || DEFAULT_SKIN;
};

export const initializeSkinProvider = () => {
  if (initialized) {
    applyActiveSkin(resolveSkin(), null);
    return skinState();
  }

  initialized = true;
  applyActiveSkin(resolveSkin(), null);

  const syncFromLocation = () => {
    // Only override the current skin when the URL EXPLICITLY carries a skin
    // selector. Plain in-app navigation (hash route changes without a skin
    // query) must not snap the skin back to the default or to a stale
    // ?skin= param left over from the initial load.
    const q = parseSkinFromQuery() || parseSkinFromHash();
    if (q) {
      setSkinState(q);
      applySkinClass(q);
    }
  };

  window.addEventListener('hashchange', syncFromLocation);
  window.addEventListener('popstate', syncFromLocation);

  return skinState();
};

const stripSkinFromSearch = () => {
  if (typeof window === 'undefined') return;

  const params = new URLSearchParams(window.location.search || '');
  if (!params.has('skin')) return;

  params.delete('skin');
  const newSearch = params.toString();
  const newUrl =
    window.location.pathname +
    (newSearch ? `?${newSearch}` : '') +
    (window.location.hash || '');
  window.history.replaceState(window.history.state, '', newUrl);
};

const stripSkinFromHash = () => {
  if (typeof window === 'undefined') return;

  const hash = window.location.hash || '';
  const hashPayload = hash.startsWith('#') ? hash.slice(1) : hash;
  const [hashPath, hashQuery] = hashPayload.split('?');
  if (!hashQuery) return;

  const params = new URLSearchParams(hashQuery);
  if (!params.has('skin')) return;

  params.delete('skin');
  const newQuery = params.toString();
  const newHash = `#${hashPath}${newQuery ? `?${newQuery}` : ''}`;
  const newUrl = window.location.pathname + window.location.search + newHash;
  window.history.replaceState(window.history.state, '', newUrl);
};

export const setSkin = (skin) => {
  if (!isValidSkin(skin)) {
    return skinState();
  }

  writeStoredSkin(skin);
  setSkinState(skin);
  applySkinClass(skin);

  // A stale ?skin= param (query or hash-query) must not fight this choice
  // on the next hashchange/popstate.
  stripSkinFromSearch();
  stripSkinFromHash();

  return skin;
};

export const setSkinStateForServer = setSkinState;

export const getSkin = () => skinState();

export const getActiveSkin = skinState;

export const setLocalSkinPreference = (skin) => {
  if (!isValidSkin(skin)) {
    throw new Error('Invalid skin');
  }

  return setSkin(skin);
};

export const setSkinPreference = async (skin) => {
  setLocalSkinPreference(skin);
  try {
    const response = await api.users.updateUiPreferences(skin);
    return response?.skin || skin;
  } catch {
    return skin;
  }
};

export const syncSkinWithServer = async () => {
  // When skin is explicitly selected via URL, do not let server preference
  // override it during this navigation session.
  const locationSkin = parseSkinFromQuery() || parseSkinFromHash();
  if (locationSkin && VALID_SKINS.includes(locationSkin)) {
    setSkinState(locationSkin);
    applySkinClass(locationSkin);
    return locationSkin;
  }

  const response = await api.users.getUiPreferences();
  if (response?.skin && VALID_SKINS.includes(response.skin)) {
    writeStoredSkin(response.skin);
    setSkinState(response.skin);
    applySkinClass(response.skin);
    return response.skin;
  }

  return null;
};

export { skinState, isValidSkin, VALID_SKINS, DEFAULT_SKIN };
