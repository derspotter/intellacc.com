// frontend/src/services/signalLib.js
// Wrapper around @signalapp/libsignal-client (WASM). Falls back to placeholders so the app keeps working.

let _lib = null;
let _provider = 'none';

async function ensureLoaded() {
  if (_lib) return _lib;
  try {
    // Preferred modern WASM client from https://github.com/signalapp/libsignal
    const name = '@signalapp/' + 'libsignal-client';
    // eslint-disable-next-line no-undef
    _lib = await import(/* @vite-ignore */ name);
    _provider = 'client';
    try { if (typeof _lib.init === 'function') await _lib.init(); } catch {}
    return _lib;
  } catch (e) {
    _lib = null; // keep null to indicate placeholder fallback
    _provider = 'none';
    return null;
  }
}

function b64rand(len = 32) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

function bufToB64(buf) {
  try {
    return btoa(String.fromCharCode(...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
  } catch { return ''; }
}

function b64ToBytes(b64) {
  try {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return new Uint8Array(); }
}

import signalStorage, { identityStore, prekeyStore, sessionStore } from './signalStorage.js';
import protocolStore from './signalProtocolStore.js';

export default {
  // Returns true if the real library is present
  async isAvailable() {
    return !!(await ensureLoaded());
  },

  // Generate identity and signing keys (placeholder until real lib is installed)
  async generateIdentity() {
    const lib = await ensureLoaded();
    // Return existing identity if present
    try {
      const existing = await identityStore.get();
      if (existing && existing.identityKey && existing.signingKey) return existing;
    } catch {}
    try {
      if (_provider === 'client' && lib) {
        // Attempt modern API shapes guardedly
        if (lib.IdentityKeyPair && typeof lib.IdentityKeyPair.generate === 'function') {
          const kp = await lib.IdentityKeyPair.generate();
          const pub = kp.publicKey?.serialize ? kp.publicKey.serialize() : (kp.publicKeyBytes || kp.publicKey);
          const priv = kp.privateKey?.serialize ? kp.privateKey.serialize() : (kp.privateKeyBytes || kp.privateKey);
          const identity = { identityKey: bufToB64(pub), signingKey: bufToB64(priv) };
          try { await identityStore.set(identity); } catch {}
          return identity;
        }
      }
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn('signalLib.generateIdentity fell back:', e?.message || e);
    }
    const identity = {
      identityKey: b64rand(32),
      signingKey: b64rand(32)
    };
    try { await identityStore.set(identity); } catch {}
    return identity;
  },

  // Generate a signed prekey and batch of one-time prekeys
  async generatePrekeys(count = 50) {
    const lib = await ensureLoaded();
    try {
      if (_provider === 'client' && lib) {
        const id = await identityStore.get();
        if (id) {
          const base = Math.floor((Date.now()) % 100000);
          const identityPair = { pubKey: b64ToBytes(id.identityKey), privKey: b64ToBytes(id.signingKey) };

          // Helper to extract bytes from various return shapes
          const getBytes = (obj, fields) => {
            for (const f of fields) {
              const v = typeof f === 'function' ? f(obj) : obj?.[f];
              if (!v) continue;
              try {
                if (v instanceof Uint8Array) return v;
                if (typeof v.serialize === 'function') return v.serialize();
                if (ArrayBuffer.isView(v)) return new Uint8Array(v);
              } catch {}
            }
            return null;
          };

          let spkPubB64 = '', spkSigB64 = '';
          // Prefer modern functions if present
          if (typeof lib.generateSignedPreKey === 'function') {
            try {
              const spr = await lib.generateSignedPreKey(identityPair, base);
              const pub = getBytes(spr, ['publicKey', (o)=>o?.keyPair?.publicKey, 'pubKey']);
              const sig = getBytes(spr, ['signature', 'sig']);
              if (pub) spkPubB64 = bufToB64(pub);
              if (sig) spkSigB64 = bufToB64(sig);
            } catch {}
          } else if (lib.KeyHelper && typeof lib.KeyHelper.generateSignedPreKey === 'function') {
            try {
              const spr = await lib.KeyHelper.generateSignedPreKey(identityPair, base);
              const pub = getBytes(spr, ['publicKey', (o)=>o?.keyPair?.publicKey, 'pubKey']);
              const sig = getBytes(spr, ['signature', 'sig']);
              if (pub) spkPubB64 = bufToB64(pub);
              if (sig) spkSigB64 = bufToB64(sig);
            } catch {}
          }

          const oneTimePreKeys = [];
          for (let i = 0; i < count; i++) {
            const keyId = base + i + 1;
            let pubB64 = '';
            try {
              if (typeof lib.generatePreKey === 'function') {
                const pr = await lib.generatePreKey(keyId);
                const pub = getBytes(pr, ['publicKey', (o)=>o?.keyPair?.publicKey, 'pubKey']);
                if (pub) pubB64 = bufToB64(pub);
              } else if (lib.KeyHelper && typeof lib.KeyHelper.generatePreKey === 'function') {
                const pr = await lib.KeyHelper.generatePreKey(keyId);
                const pub = getBytes(pr, ['publicKey', (o)=>o?.keyPair?.publicKey, 'pubKey']);
                if (pub) pubB64 = bufToB64(pub);
              }
            } catch {}
            oneTimePreKeys.push({ keyId, publicKey: pubB64 || b64rand(32) });
          }

          const signedPreKey = { keyId: base, publicKey: spkPubB64 || b64rand(32), signature: spkSigB64 || b64rand(64) };
          await prekeyStore.setSignedPreKey(signedPreKey);
          await prekeyStore.addOneTimePreKeys(oneTimePreKeys);
          return { signedPreKey, oneTimePreKeys };
        }
      }
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn('signalLib.generatePrekeys fell back:', e?.message || e);
    }
    const now = Date.now();
    const base = Math.floor(now % 100000);
    const signedPreKey = { keyId: base, publicKey: b64rand(32), signature: b64rand(64) };
    const oneTimePreKeys = Array.from({ length: count }).map((_, i) => ({ keyId: base + i + 1, publicKey: b64rand(32) }));
    try {
      await prekeyStore.setSignedPreKey(signedPreKey);
      await prekeyStore.addOneTimePreKeys(oneTimePreKeys);
    } catch {}
    return { signedPreKey, oneTimePreKeys };
  },

  // Session ensure/encrypt/decrypt (wires to storage; uses lib when present)
  async ensureSession(peerUserId, peerBundle) {
    try {
      const existing = await sessionStore.get(peerUserId);
      if (existing) return existing;
      const lib = await ensureLoaded();
      if (_provider === 'client' && lib && peerBundle) {
        try {
          // Build a session using common PreKeyBundle shape if available
          const addr = lib.SignalProtocolAddress ? new lib.SignalProtocolAddress(String(peerUserId), 1) : null;
          if (addr && lib.SessionBuilder && lib.PreKeyBundle) {
            const regId = peerBundle.registrationId || 1;
            const deviceId = peerBundle.deviceId || 1;
            const preKeyId = peerBundle.oneTimePreKey?.keyId || 0;
            const preKeyPublic = peerBundle.oneTimePreKey?.publicKey ? b64ToBytes(peerBundle.oneTimePreKey.publicKey) : new Uint8Array();
            const signedPreKeyId = peerBundle.signedPreKey?.keyId || 1;
            const signedPreKeyPublic = peerBundle.signedPreKey?.publicKey ? b64ToBytes(peerBundle.signedPreKey.publicKey) : new Uint8Array();
            const signedPreKeySignature = peerBundle.signedPreKey?.signature ? b64ToBytes(peerBundle.signedPreKey.signature) : new Uint8Array();
            const identityKey = peerBundle.identityKey ? b64ToBytes(peerBundle.identityKey) : new Uint8Array();
            const bundle = new lib.PreKeyBundle(
              regId,
              deviceId,
              preKeyId,
              preKeyPublic,
              signedPreKeyId,
              signedPreKeyPublic,
              signedPreKeySignature,
              identityKey
            );
            const builder = new lib.SessionBuilder(protocolStore, addr);
            await builder.processPreKeyBundle(bundle);
            const sess = { createdAt: Date.now(), provider: 'client', peerBundle };
            await sessionStore.set(peerUserId, sess);
            return sess;
          }
        } catch (e) {
          if (import.meta?.env?.DEV) console.warn('signalLib.ensureSession fell back:', e?.message || e);
        }
        const sess = { createdAt: Date.now(), provider: 'client', peerBundle };
        await sessionStore.set(peerUserId, sess);
        return sess;
      }
      const sess = { createdAt: Date.now(), provider: 'placeholder', peerBundle: peerBundle || null };
      await sessionStore.set(peerUserId, sess);
      return sess;
    } catch (e) {
      const sess = { createdAt: Date.now(), provider: 'placeholder' };
      try { await sessionStore.set(peerUserId, sess); } catch {}
      return sess;
    }
  },

  async encrypt(plaintext, peerUserId) {
    const lib = await ensureLoaded();
    try {
      if (_provider === 'client' && lib && plaintext != null) {
        const text = new TextEncoder().encode(String(plaintext));
        if (lib.SignalProtocolAddress && lib.SessionCipher) {
          const addr = new lib.SignalProtocolAddress(String(peerUserId), 1);
          const cipher = new lib.SessionCipher(protocolStore, addr);
          const result = await cipher.encrypt(text);
          let bytes = null;
          if (result && typeof result.serialize === 'function') bytes = result.serialize();
          else if (result && result.ciphertext) bytes = result.ciphertext;
          if (bytes) return btoa(String.fromCharCode(...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))));
        }
      }
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn('signalLib.encrypt fell back:', e?.message || e);
    }
    return btoa(String(plaintext || ''));
  },

  async decrypt(envelopeB64, peerUserId) {
    const lib = await ensureLoaded();
    try {
      if (_provider === 'client' && lib && envelopeB64) {
        const bin = atob(String(envelopeB64||''));
        const bytes = new Uint8Array(bin.length);
        for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        if (lib.SignalProtocolAddress && lib.SessionCipher) {
          const addr = new lib.SignalProtocolAddress(String(peerUserId || 'peer'), 1);
          const cipher = new lib.SessionCipher(protocolStore, addr);
          let plain = null;
          if (typeof cipher.decryptPreKeyMessage === 'function') {
            try { plain = await cipher.decryptPreKeyMessage(bytes); } catch {}
          }
          if (!plain && typeof cipher.decryptSignalMessage === 'function') {
            try { plain = await cipher.decryptSignalMessage(bytes); } catch {}
          }
          if (plain) return new TextDecoder().decode(plain);
        }
      }
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn('signalLib.decrypt fell back:', e?.message || e);
    }
    return atob(String(envelopeB64));
  }
};
