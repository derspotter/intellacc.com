/**
 * Stake sizing helpers shared by the trade tickets (Van MarketEventCard and
 * Terminal MarketDetail).
 *
 * The engine's `kelly_suggestion` is already scaled by its configured
 * fraction (MARKET_KELLY_FRACTION, default 0.25). The UI wants to offer a
 * quarter / half / full Kelly choice, so we normalise back to *full* Kelly
 * first and apply the user's chosen fraction on top.
 */

export const KELLY_FRACTIONS = [0.25, 0.5, 1];
export const DEFAULT_KELLY_FRACTION = 0.25;

/** Historical engine default, used only when the response omits `kelly_fraction`. */
const LEGACY_ENGINE_FRACTION = 0.25;

const toFinite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const normalizeKellyFraction = (value) => {
  const n = Number(value);
  return KELLY_FRACTIONS.includes(n) ? n : DEFAULT_KELLY_FRACTION;
};

export const fullKellyFromSuggestion = (data) => {
  if (!data || typeof data !== 'object') return 0;
  if (data.full_kelly != null) return Math.max(0, toFinite(data.full_kelly));
  const suggestion = toFinite(data.kelly_suggestion);
  const fraction = toFinite(data.kelly_fraction, LEGACY_ENGINE_FRACTION);
  if (suggestion <= 0 || fraction <= 0) return 0;
  return suggestion / fraction;
};

/**
 * Stake (as the string the number input wants) for a chosen fraction of full
 * Kelly, never above the user's balance. Empty when there is nothing to stake.
 */
export const stakeForFraction = (fullKelly, fraction, balance) => {
  const scaled = toFinite(fullKelly) * normalizeKellyFraction(fraction);
  const capped = Number.isFinite(toFinite(balance, NaN)) ? Math.min(scaled, toFinite(balance)) : scaled;
  if (!(capped > 0)) return '';
  return capped.toFixed(2);
};

/**
 * Track background for the belief slider: NO colour at 0, neutral exactly at
 * the current market price, YES colour at 1. The neutral spot therefore moves
 * with the market, and distance from it is the user's edge.
 */
export const beliefTrackGradient = (marketProb, { no, mid, yes }) => {
  const p = toFinite(marketProb, 0.5);
  const clamped = Math.min(1, Math.max(0, p));
  const pct = Math.round(clamped * 1000) / 10;
  return `linear-gradient(to right, ${no} 0%, ${mid} ${pct}%, ${yes} 100%)`;
};
