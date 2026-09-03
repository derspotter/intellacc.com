/**
 * Proactive verification gate for trading.
 *
 * Trading routes require tier 2 (phone). Until now the requirement only
 * surfaced as a 403 after the user tried to trade; this module lets the
 * predictions surfaces say so up front. Status is cached briefly so the
 * page, the weekly card and the trade ticket share one request.
 */
import { createResource } from 'solid-js';
import { api } from './api';
import { getToken } from './tokenService';
import { PHONE_TIER, PHONE_GATE_MESSAGE, needsPhoneVerification } from '../lib/phoneGate';

export { PHONE_TIER, PHONE_GATE_MESSAGE, needsPhoneVerification };
const CACHE_TTL_MS = 60_000;

let cached = null;
let cachedAt = 0;
let inflight = null;

export const invalidateVerificationStatus = () => {
  cached = null;
  cachedAt = 0;
  inflight = null;
};

export const fetchVerificationStatus = async () => {
  if (!getToken()) return null;
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = api.verification.getStatus()
    .then((status) => {
      cached = status || null;
      cachedAt = Date.now();
      return cached;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
};

/** Solid resource: `needsPhone()` is true only once status is known. */
export const createPhoneGate = () => {
  const [status] = createResource(() => (getToken() ? 'me' : null), fetchVerificationStatus);
  const needsPhone = () => needsPhoneVerification(status());
  return { status, needsPhone };
};
