/** Pure part of the trading verification gate (see services/verificationGate.js). */
export const PHONE_TIER = 2;
export const PHONE_GATE_MESSAGE = 'Trading predictions requires phone verification.';

/** True when the status is known and the tier is below the trading requirement. */
export const needsPhoneVerification = (status) => {
  if (!status || typeof status !== 'object') return false;
  const tier = Number(status.current_tier ?? status.tier ?? 0);
  return Number.isFinite(tier) && tier < PHONE_TIER;
};
