import van from 'vanjs-core';
import { api } from './api';
import { isLoggedInState } from './tokenService';

const VALID_SKINS = ['van', 'terminal'];
const DEFAULT_SKIN = 'van';
const STORAGE_KEY = 'intellacc.ui.skin';

const isValidSkin = (skin) => VALID_SKINS.includes(skin);

const parseSkinFromHash = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const hash = window.location.hash || '';
  const hashPayload = hash.startsWith('#') ? hash.slice(1) : hash;
  const [, queryString] = hashPayload.split('?');
  if (!queryString) {
    return null;
  }

  const params = new URLSearchParams(queryString);
  const skin = params.get('skin');
  return isValidSkin(skin) ? skin : null;
};

const parseSkinFromQuery = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search || '');
  const skin = params.get('skin');
  return isValidSkin(skin) ? skin : null;
};

const parseSkinFromLocation = () => parseSkinFromQuery() || parseSkinFromHash();

const readStoredSkin = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  return isValidSkin(stored) ? stored : null;
};

const writeStoredSkin = (skin) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (isValidSkin(skin)) {
    localStorage.setItem(STORAGE_KEY, skin);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
};

const applySkinClass = (skin) => {
  if (typeof document === 'undefined') {
    return;
  }

  VALID_SKINS.forEach((validSkin) => {
    document.body.classList.remove(`skin-${validSkin}`);
  });
  document.body.classList.add(`skin-${skin}`);
  document.body.dataset.skin = skin;
};

const state = {
  querySkin: null,
  serverSkin: null,
  localSkin: readStoredSkin(),
  initialized: false
};

export const activeSkin = van.state(DEFAULT_SKIN);

const resolveSkin = () => state.querySkin || state.serverSkin || state.localSkin || DEFAULT_SKIN;

const applyActiveSkin = () => {
  const skin = resolveSkin();
  activeSkin.val = skin;
  applySkinClass(skin);
  return skin;
};

export const initializeSkinProvider = () => {
  if (state.initialized) {
    return activeSkin.val;
  }

  state.initialized = true;
  state.querySkin = parseSkinFromLocation();

  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
      state.querySkin = parseSkinFromLocation();
      applyActiveSkin();
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
      state.querySkin = parseSkinFromLocation();
      applyActiveSkin();
    });
  }

  return applyActiveSkin();
};

export const setLocalSkinPreference = (skin) => {
  if (!isValidSkin(skin)) {
    throw new Error('Invalid skin');
  }

  state.localSkin = skin;
  writeStoredSkin(skin);
  if (!state.querySkin) {
    applyActiveSkin();
  }
  return skin;
};

export const setServerSkinPreference = (skin) => {
  if (!isValidSkin(skin)) {
    throw new Error('Invalid skin');
  }

  state.serverSkin = skin;
  if (!state.querySkin) {
    applyActiveSkin();
  }
  return skin;
};

export const clearServerSkinPreference = () => {
  state.serverSkin = null;
  return applyActiveSkin();
};

export const clearQuerySkinOverride = () => {
  state.querySkin = null;
  return applyActiveSkin();
};

export const syncSkinWithServer = async () => {
  if (!isLoggedInState.val) {
    state.serverSkin = null;
    return null;
  }

  try {
    const preferences = await api.users.getUiPreferences();
    if (isValidSkin(preferences?.skin)) {
      setServerSkinPreference(preferences.skin);
      return preferences.skin;
    }
    clearServerSkinPreference();
    return null;
  } catch (error) {
    console.warn('Failed to load UI skin preference from server:', error?.message || error);
    return null;
  }
};

export const saveSkinPreference = async (skin) => {
  const normalized = isValidSkin(skin) ? skin : null;
  if (!normalized) {
    throw new Error('Invalid skin');
  }

  // Apply immediately for instant UX; if server save fails, we keep local behavior.
  setLocalSkinPreference(normalized);

  try {
    const saved = await api.users.updateUiPreferences(normalized);
    if (isValidSkin(saved?.skin)) {
      setServerSkinPreference(saved.skin);
      return saved.skin;
    }
  } catch (error) {
    console.warn('Failed to persist UI skin preference:', error?.message || error);
    throw error;
  }

  return normalized;
};
