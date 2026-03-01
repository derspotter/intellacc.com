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
  // Persist explicit hash/query skin so auth redirects that rewrite the hash
  // (e.g. #home?skin=terminal -> #login) keep the selected skin.
  if (querySkin) {
    writeStoredSkin(querySkin);
  }
  setSkinState(nextSkin);
  applySkinClass(nextSkin);
  return nextSkin;
};

let initialized = false;

export const resolveSkin = () => {
  const querySkin = parseSkinFromQuery() || parseSkinFromHash();
  const stored = readStoredSkin();
  return querySkin || stored || DEFAULT_SKIN;
};

export const initializeSkinProvider = () => {
  if (initialized) {
    applyActiveSkin(resolveSkin(), null);
    return skinState();
  }

  initialized = true;
  applyActiveSkin(resolveSkin(), null);

  const syncFromLocation = () => {
    applyActiveSkin(resolveSkin(), null);
  };

  window.addEventListener('hashchange', syncFromLocation);
  window.addEventListener('popstate', syncFromLocation);

  return skinState();
};

export const setSkin = (skin) => {
  if (!isValidSkin(skin)) {
    return skinState();
  }

  writeStoredSkin(skin);
  setSkinState(skin);
  applySkinClass(skin);
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
    writeStoredSkin(locationSkin);
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
