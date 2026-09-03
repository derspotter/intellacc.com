/**
 * Small localStorage wrapper plus a Solid signal that mirrors into it.
 *
 * Used for form drafts (survive hash-route switches, which unmount the
 * composer), the predictions list filters, and the remembered Kelly fraction.
 * Every storage call is guarded: private mode, blocked storage, or corrupt
 * JSON must never break the page.
 */
import { createSignal, createEffect, on } from 'solid-js';

export const createJsonStorage = (storage) => {
  const get = (key, fallback) => {
    if (!storage) return fallback;
    try {
      const raw = storage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const set = (key, value) => {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: drafts are a convenience, not a contract */
    }
  };
  const remove = (key) => {
    if (!storage) return;
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
  };
  return { get, set, remove };
};

const browserStorage = () => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

export const jsonStorage = createJsonStorage(browserStorage());

export const draftKey = (scope, userId) => `draft:${userId ?? 'anon'}:${scope}`;

/**
 * A signal whose value is loaded from storage on creation and written back on
 * every change. `clear()` resets to the initial value and removes the key —
 * call it after a successful submit so a sent draft does not resurface.
 */
export const createPersistedSignal = (key, initial, { storage = jsonStorage } = {}) => {
  const [value, setValue] = createSignal(storage.get(key, initial));
  createEffect(on(value, (next) => {
    storage.set(key, next);
  }, { defer: true }));
  const clear = () => {
    setValue(() => initial);
    storage.remove(key);
  };
  return [value, setValue, clear];
};

/**
 * Draft signal whose storage key can change (e.g. per group slug). Loads the
 * draft whenever the key changes and writes every edit back under the
 * current key. `clear()` after a successful submit removes the stored draft.
 */
export const createDraftSignal = (keyAccessor, initial, { storage = jsonStorage } = {}) => {
  const [value, setValue] = createSignal(initial);
  let currentKey = null;
  createEffect(on(keyAccessor, (key) => {
    currentKey = key || null;
    setValue(() => (currentKey ? storage.get(currentKey, initial) : initial));
  }));
  createEffect(on(value, (next) => {
    if (currentKey) storage.set(currentKey, next);
  }, { defer: true }));
  const clear = () => {
    setValue(() => initial);
    if (currentKey) storage.remove(currentKey);
  };
  return [value, setValue, clear];
};
