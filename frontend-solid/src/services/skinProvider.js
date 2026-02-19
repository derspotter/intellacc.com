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

let querySkin = parseSkinFromQuery() || parseSkinFromHash();
let storedSkin = readStoredSkin();
const [activeSkin, setActiveSkin] = createSignal(storedSkin || querySkin || DEFAULT_SKIN);

const applySkinClass = (skin) => {
  if (typeof document === 'undefined') return;

  VALID_SKINS.forEach((name) => {
    document.body.classList.remove(`skin-${name}`);
  });
  document.body.classList.add(`skin-${skin}`);
  document.body.dataset.skin = skin;
};

const applyActiveSkin = () => {
  const skin = querySkin || storedSkin || DEFAULT_SKIN;
  setActiveSkin(skin);
  applySkinClass(skin);
  return skin;
};

let initialized = false;

export const initializeSkinProvider = () => {
  if (initialized) {
    applyActiveSkin();
    return activeSkin();
  }

  initialized = true;
  storedSkin = readStoredSkin();
  querySkin = parseSkinFromQuery() || parseSkinFromHash();

  applyActiveSkin();

  const syncFromLocation = () => {
    querySkin = parseSkinFromQuery() || parseSkinFromHash();
    applyActiveSkin();
  };

  window.addEventListener('hashchange', syncFromLocation);
  window.addEventListener('popstate', syncFromLocation);

  return activeSkin();
};

export const setLocalSkinPreference = (skin) => {
  if (!isValidSkin(skin)) {
    throw new Error('Invalid skin');
  }
  storedSkin = skin;
  writeStoredSkin(skin);
  applyActiveSkin();
  return skin;
};

export const setSkinPreference = async (skin) => {
  setLocalSkinPreference(skin);
  try {
    const response = await api.users.updateUiPreferences(skin);
    return response?.skin || skin;
  } catch {
    // local persistence is the fallback
    return skin;
  }
};

export const syncSkinWithServer = async () => {
  const response = await api.users.getUiPreferences();
  if (response && response.skin && VALID_SKINS.includes(response.skin)) {
    storedSkin = response.skin;
    writeStoredSkin(response.skin);
    applyActiveSkin();
    return response.skin;
  }
  return null;
};

export const getActiveSkin = activeSkin;
