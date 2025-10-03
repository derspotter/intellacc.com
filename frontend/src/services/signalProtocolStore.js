// frontend/src/services/signalProtocolStore.js
// Minimal Signal protocol store facade mapping to our storage adapters.
// Mirrors the common libsignal store shape to ease wiring with @signalapp/libsignal-client.

import { identityStore, prekeyStore, sessionStore } from './signalStorage.js';

function b64ToBytes(b64) {
  try {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return new Uint8Array(); }
}

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))));
}

const REG_ID_KEY = 'signal_local_registration_id';

export default {
  async getIdentityKeyPair() {
    const id = await identityStore.get();
    if (!id) return null;
    return {
      pubKey: b64ToBytes(id.identityKey),
      privKey: b64ToBytes(id.signingKey)
    };
  },

  async getLocalRegistrationId() {
    let n = parseInt(localStorage.getItem(REG_ID_KEY) || '0');
    if (!n || Number.isNaN(n)) {
      n = Math.floor(Math.random() * 2 ** 16) + 1; // 1..65536
      localStorage.setItem(REG_ID_KEY, String(n));
    }
    return n;
  },

  async getPreKey(keyId) {
    const rec = await prekeyStore.getOneTimePreKey(Number(keyId));
    if (!rec) return null;
    // Return a structure the client can consume: prefer raw bytes fields
    return {
      keyId: rec.keyId,
      publicKey: rec.publicKey ? b64ToBytes(rec.publicKey) : new Uint8Array(),
      privKey: rec.privKey ? b64ToBytes(rec.privKey) : new Uint8Array(),
      used: !!rec.used
    };
  },

  async getSignedPreKey(keyId) {
    const rec = await prekeyStore.getSignedPreKey?.(Number(keyId));
    const spk = rec || (await prekeyStore.getSignedPreKey?.());
    if (!spk) return null;
    return {
      keyId: spk.keyId,
      publicKey: spk.publicKey ? b64ToBytes(spk.publicKey) : new Uint8Array(),
      privKey: spk.privKey ? b64ToBytes(spk.privKey) : new Uint8Array(),
      signature: spk.signature ? b64ToBytes(spk.signature) : new Uint8Array()
    };
  },

  async storeSession(peerAddress, recordBytes) {
    // peerAddress may be stringified user id for our case
    try { await sessionStore.set(String(peerAddress), { blob: bytesToB64(recordBytes) }); } catch {}
    return true;
  },

  async loadSession(peerAddress) {
    const rec = await sessionStore.get(String(peerAddress));
    if (!rec || !rec.blob) return null;
    return b64ToBytes(rec.blob);
  },

  async containsSession(peerAddress) {
    const rec = await sessionStore.get(String(peerAddress));
    return !!rec;
  },

  async removeSession(peerAddress) {
    // Not strictly needed for MVP
    return true;
  },

  async isTrustedIdentity(/* address, identityKey */) {
    // For MVP, trust all; wire verification later.
    return true;
  },

  async saveIdentity(/* address, identityKey */) {
    // Store peer identity for verification if desired
    return true;
  }
};
