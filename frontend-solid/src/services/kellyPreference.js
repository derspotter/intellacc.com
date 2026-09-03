/**
 * Per-account Kelly fraction (¼ / ½ / 1×) used to auto-fill stakes.
 *
 * One shared signal for every trade ticket. localStorage is the instant
 * cache; the server preference (PUT/GET /users/me/preferences) is the
 * source of truth across devices: read once after login, written on toggle.
 */
import { api } from './api';
import { getToken } from './tokenService';
import { createPersistedSignal } from '../lib/persistedState';
import { DEFAULT_KELLY_FRACTION, normalizeKellyFraction } from '../lib/kellyStake';

const [kellyFraction, setLocalKellyFraction] = createPersistedSignal('kellyFraction', DEFAULT_KELLY_FRACTION);

export { kellyFraction };

export const setKellyFractionPreference = async (value) => {
  const fraction = normalizeKellyFraction(value);
  setLocalKellyFraction(fraction);
  if (!getToken()) return fraction;
  try {
    await api.users.updateUiPreferences({ kelly_fraction: fraction });
  } catch {
    /* local value still applies; the server catches up on the next toggle */
  }
  return fraction;
};

export const syncKellyFractionWithServer = async () => {
  if (!getToken()) return null;
  try {
    const prefs = await api.users.getUiPreferences();
    if (prefs?.kelly_fraction != null) {
      setLocalKellyFraction(normalizeKellyFraction(prefs.kelly_fraction));
      return kellyFraction();
    }
  } catch {
    /* offline or unauthenticated: keep the local value */
  }
  return null;
};
