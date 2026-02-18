import { createSignal } from 'solid-js';

const VALID_SKINS = ['van', 'terminal'];
const DEFAULT_SKIN = 'van';
const STORAGE_KEY = 'intellacc.ui.skin';

const isValidSkin = (skin) => VALID_SKINS.includes(skin);

const parseSkinFromLocation = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search || '');
  const fromQuery = params.get('skin');
  if (isValidSkin(fromQuery)) {
    return fromQuery;
  }

  const hash = window.location.hash || '';
  const [, queryPart] = hash.replace(/^#/, '').split('?');
  if (!queryPart) {
    return null;
  }
  const hashParams = new URLSearchParams(queryPart);
  const fromHash = hashParams.get('skin');
  return isValidSkin(fromHash) ? fromHash : null;
};

const readStoredSkin = () => {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  const skin = localStorage.getItem(STORAGE_KEY);
  return isValidSkin(skin) ? skin : null;
};

const applySkinToDom = (skin) => {
  if (typeof document === 'undefined') {
    return;
  }
  ['van', 'terminal'].forEach((name) => document.body.classList.remove(`skin-${name}`));
  document.body.classList.add(`skin-${skin}`);
  document.body.dataset.skin = skin;
};

const resolveSkin = () => {
  const hashSkin = parseSkinFromLocation();
  const localSkin = readStoredSkin();
  return hashSkin || localSkin || DEFAULT_SKIN;
};

const [skinState, setSkinState] = createSignal(DEFAULT_SKIN);

export const initializeSkinProvider = () => {
  const initial = resolveSkin();
  setSkinState(initial);
  applySkinToDom(initial);

  const reapply = () => {
    const next = resolveSkin();
    setSkinState(next);
    applySkinToDom(next);
  };

  window.addEventListener('hashchange', reapply);
  window.addEventListener('popstate', reapply);
};

export const setSkin = (skin) => {
  if (!isValidSkin(skin)) {
    return;
  }
  localStorage.setItem(STORAGE_KEY, skin);
  setSkinState(skin);
  applySkinToDom(skin);
};

export const getSkin = () => skinState();
export { skinState, setSkinState };
