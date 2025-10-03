// frontend/src/services/messaging-legacy/signalStorage.js
// Minimal, swappable storage for Signal identity/prekeys/sessions.
// Uses in-memory fallback for tests; IndexedDB hooks can be added incrementally.

import { idbIdentity, idbPrekeys, idbSessions } from './signalIndexedDB.js';

const mem = {
  identity: null,
  signedPreKey: null,
  oneTimePreKeys: new Map(), // keyId -> { keyId, publicKey, used }
  sessions: new Map() // peerUserId -> state blob
};

export const identityStore = {
  async get() {
    // Prefer IndexedDB when available
    try { const v = await idbIdentity.get(); if (v) return v; } catch {}
    return mem.identity; // { identityKey, signingKey } (base64 strings)
  },
  async set(identity) {
    mem.identity = identity;
    try { await idbIdentity.set(identity); } catch {}
    return true;
  }
};

export const prekeyStore = {
  async setSignedPreKey(spk) {
    // spk may include { keyId, publicKey, signature, privKey }
    mem.signedPreKey = spk;
    try { await idbPrekeys.setSignedPreKey(spk); } catch {}
    return true;
  },
  async addOneTimePreKeys(list) {
    for (const k of list || []) {
      if (!k || typeof k.keyId !== 'number') continue;
      // k may include { keyId, publicKey, privKey }
      mem.oneTimePreKeys.set(k.keyId, { ...k, used: false });
    }
    try { await idbPrekeys.addOneTimePreKeys(list); } catch {}
    return mem.oneTimePreKeys.size;
  },
  async getOneTimePreKey(keyId) {
    const rec = mem.oneTimePreKeys.get(keyId);
    return rec || null;
  },
  async countAvailable() {
    // Try IndexedDB count
    try { const n = await idbPrekeys.countAvailable(); if (n) return n; } catch {}
    let n = 0;
    for (const v of mem.oneTimePreKeys.values()) if (!v.used) n++;
    return n;
  },
  async markUsed(keyId) {
    if (mem.oneTimePreKeys.has(keyId)) {
      const v = mem.oneTimePreKeys.get(keyId);
      mem.oneTimePreKeys.set(keyId, { ...v, used: true });
      return true;
    }
    return false;
  },
  async getSignedPreKey() {
    return mem.signedPreKey || null;
  }
};

export const sessionStore = {
  async get(peerUserId) {
    try { const v = await idbSessions.get(peerUserId); if (v) return v; } catch {}
    return mem.sessions.get(String(peerUserId)) || null;
  },
  async set(peerUserId, state) {
    mem.sessions.set(String(peerUserId), state);
    try { await idbSessions.set(peerUserId, state); } catch {}
    return true;
  }
};

export default {
  identityStore,
  prekeyStore,
  sessionStore
};
