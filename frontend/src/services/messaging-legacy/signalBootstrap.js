// frontend/src/services/messaging-legacy/signalBootstrap.js
// Automatic, background bootstrap for Signal-style E2EE (no UI)

import signalKeyManager, { generateAndPublishIdentity, topUpPrekeysIfNeeded } from './signalKeyManager.js';
import { identityStore } from './signalStorage.js';
import api from '../api.js';
import { getUserId } from '../auth.js';

function b64rand(len = 32) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

const LS_KEYS = {
  idPub: 'signal_id_pub',
  signPub: 'signal_sign_pub',
  lastPublish: 'signal_last_publish_ts',
  prekeyWatermark: 'signal_prekey_watermark'
};

export async function bootstrapSignalIfNeeded() {
  try {
    console.log('[Signal] bootstrap: start');
    const now = Date.now();
    const last = Number(localStorage.getItem(LS_KEYS.lastPublish) || 0);
    const dayMs = 24 * 60 * 60 * 1000;
    let identityKey = localStorage.getItem(LS_KEYS.idPub);
    let signingKey = localStorage.getItem(LS_KEYS.signPub);
    let mustEnsureServerHasKeys = false;

    // If legacy identity exists without Olm state, regenerate
    let haveOlmState = false;
    try { const cur = await identityStore.get(); haveOlmState = !!(cur && cur.olmPickle); } catch {}

    // Generate identity via signalLib wrapper when missing or when no Olm state present
    if (!identityKey || !signingKey || !haveOlmState) {
      console.log('[Signal] bootstrap: generating new identity');
      const id = await generateAndPublishIdentity();
      identityKey = id.identityKey;
      signingKey = id.signingKey;
      localStorage.setItem(LS_KEYS.idPub, identityKey);
      localStorage.setItem(LS_KEYS.signPub, signingKey);
      localStorage.setItem(LS_KEYS.lastPublish, String(now));
    } else {
      // If not freshly generated, check server presence and freshness
      try {
        const me = getUserId && getUserId();
        console.log('[Signal] bootstrap: have local identity, checking server bundle for', me);
        if (me) {
          // If server has no bundle (fresh DB) or missing signed prekey, force publish
          const bundle = await api.e2ee.getBundle(Number(me));
          if (!bundle || !bundle.identityKey || !bundle.signedPreKey) {
            console.log('[Signal] bootstrap: server bundle incomplete/missing -> will publish');
            mustEnsureServerHasKeys = true;
          }
        }
      } catch (e) {
        // Treat 404 as missing -> must publish
        const status = Number(e?.status || 0);
        const msg = String(e?.message || '');
        if (status === 404 || msg.includes('No key bundle')) mustEnsureServerHasKeys = true;
        console.log('[Signal] bootstrap: server bundle check error -> publish', status, msg);
      }

      // Always publish identity to guarantee server has our keys (idempotent on backend)
      console.log('[Signal] bootstrap: publishing identity');
      await signalKeyManager.publishIdentity(identityKey, signingKey);
      localStorage.setItem(LS_KEYS.lastPublish, String(now));
    }

    // Replenish one-time prekeys when watermark low
    const watermark = Number(localStorage.getItem(LS_KEYS.prekeyWatermark) || 0);
    // Always publish a fresh batch of prekeys to ensure availability (backend de-duplicates)
    console.log('[Signal] bootstrap: publishing prekeys');
    const prekeys = await topUpPrekeysIfNeeded(20, 50);
    if (prekeys && prekeys.oneTimePreKeys) {
      localStorage.setItem(LS_KEYS.prekeyWatermark, String(prekeys.oneTimePreKeys.length));
    }
    console.log('[Signal] bootstrap: done');
  } catch (e) {
    // Soft-fail; will retry on next tick/login
    console.warn('Signal bootstrap skipped:', e?.message || e);
  }
}
