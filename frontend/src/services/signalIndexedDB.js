// frontend/src/services/signalIndexedDB.js
// Lightweight IndexedDB adapter for Signal identity, prekeys, and session state.
import cryptoService from './crypto.js';

const DB_NAME = 'signal_store';
const DB_VERSION = 1;
const STORES = {
  identity: 'identity',
  prekeys: 'prekeys',
  sessions: 'sessions'
};

function hasIDB() {
  try { return typeof indexedDB !== 'undefined'; } catch { return false; }
}

async function openDB() {
  if (!hasIDB()) throw new Error('IndexedDB not available');
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.identity)) db.createObjectStore(STORES.identity, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.prekeys)) db.createObjectStore(STORES.prekeys, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.sessions)) db.createObjectStore(STORES.sessions, { keyPath: 'peer' });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function getStore(storeName, mode = 'readonly') {
  const db = await openDB();
  return db.transaction([storeName], mode).objectStore(storeName);
}

export const idbIdentity = {
  async get() {
    try {
      const store = await getStore(STORES.identity, 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.get('me');
        req.onerror = () => reject(req.error);
        req.onsuccess = async () => {
          try {
            if (!req.result) return resolve(null);
            const dec = await decryptValue(req.result.value);
            resolve(dec);
          } catch { resolve(null); }
        };
      });
    } catch { return null; }
  },
  async set(value) {
    try {
      const store = await getStore(STORES.identity, 'readwrite');
      return new Promise((resolve, reject) => {
        encryptValue(value).then(enc => {
          const req = store.put({ id: 'me', value: enc });
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(true);
        }).catch(reject);
      });
    } catch { return false; }
  }
};

export const idbPrekeys = {
  async setSignedPreKey(spk) {
    try {
      const store = await getStore(STORES.prekeys, 'readwrite');
      return new Promise((resolve, reject) => {
        encryptValue(spk).then(enc => {
          const req = store.put({ key: 'signed', value: enc });
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(true);
        }).catch(reject);
      });
    } catch { return false; }
  },
  async addOneTimePreKeys(list) {
    try {
      const store = await getStore(STORES.prekeys, 'readwrite');
      const txs = list.map(k => new Promise((resolve, reject) => {
        const val = { ...k, used: false };
        encryptValue(val).then(enc => {
          const req = store.put({ key: `otp:${k.keyId}`, value: enc });
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(true);
        }).catch(reject);
      }));
      await Promise.allSettled(txs);
      return true;
    } catch { return false; }
  },
  async countAvailable() {
    try {
      const store = await getStore(STORES.prekeys, 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.getAllKeys();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const keys = (req.result || []).filter(k => String(k).startsWith('otp:'));
          resolve(keys.length);
        };
      });
    } catch { return 0; }
  }
};

export const idbSessions = {
  async get(peer) {
    try {
      const store = await getStore(STORES.sessions, 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.get(String(peer));
        req.onerror = () => reject(req.error);
        req.onsuccess = async () => {
          try {
            if (!req.result) return resolve(null);
            const dec = await decryptValue(req.result.value);
            resolve(dec);
          } catch { resolve(null); }
        };
      });
    } catch { return null; }
  },
  async set(peer, value) {
    try {
      const store = await getStore(STORES.sessions, 'readwrite');
      return new Promise((resolve, reject) => {
        encryptValue(value).then(enc => {
          const req = store.put({ peer: String(peer), value: enc });
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(true);
        }).catch(reject);
      });
    } catch { return false; }
  }
};

export default {
  idbIdentity,
  idbPrekeys,
  idbSessions
};

// --- At-rest encryption helpers ---
function getMaster() {
  try {
    let secret = localStorage.getItem('signal_master_secret');
    let saltB64 = localStorage.getItem('signal_master_salt');
    if (!secret) {
      // Generate random secret
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      secret = btoa(s);
      localStorage.setItem('signal_master_secret', secret);
    }
    if (!saltB64) {
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      saltB64 = btoa(String.fromCharCode(...salt));
      localStorage.setItem('signal_master_salt', saltB64);
    }
    return { secret, saltB64 };
  } catch {
    return { secret: 'signal_default_secret', saltB64: btoa('default_salt') };
  }
}

async function getAesKey() {
  const { secret, saltB64 } = getMaster();
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  return await cryptoService.deriveKey(secret, salt);
}

async function encryptValue(obj) {
  try {
    const key = await getAesKey();
    const plaintext = JSON.stringify(obj || null);
    const enc = await cryptoService.encryptData(key, plaintext);
    return enc; // { iv, ciphertext } base64
  } catch {
    return obj; // fallback plaintext (only in dev / non-IDB paths)
  }
}

async function decryptValue(rec) {
  try {
    if (!rec || typeof rec !== 'object' || !rec.iv || !rec.ciphertext) return rec;
    const key = await getAesKey();
    const plaintext = await cryptoService.decryptData(key, rec.iv, rec.ciphertext);
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}
