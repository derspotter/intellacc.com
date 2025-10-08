// frontend/src/services/mls/coreCryptoClient.js
// Thin bootstrap wrapper around @wireapp/core-crypto guarded by an MLS feature flag.

import {
  CoreCrypto,
  DatabaseKey,
  ClientId,
  MlsTransportData,
  ciphersuiteDefault,
  initWasmModule
} from '@wireapp/core-crypto';

const FEATURE_FLAG = String(import.meta.env.VITE_ENABLE_MLS ?? '').toLowerCase() === 'true';
const WASM_BASE = import.meta.env.VITE_CORE_CRYPTO_WASM_BASE;
const DATABASE_NAME = 'intellacc-mls-keystore';
const KEY_STORAGE_KEY = 'intellacc.mls.databaseKey';
const CLIENT_ID_STORAGE_KEY = 'intellacc.mls.clientId';

let coreCryptoInstance = null;
let initPromise = null;

const getCrypto = () => (typeof window !== 'undefined' ? window.crypto : null);
const getStorage = () => (typeof window !== 'undefined' ? window.localStorage : null);

const base64ToBytes = (value) => {
  if (!value) return null;
  try {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

const bytesToBase64 = (bytes) => {
  if (!bytes) return '';
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const randomBytes = (length) => {
  const crypto = getCrypto();
  const buffer = new Uint8Array(length);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(buffer);
    return buffer;
  }
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = Math.floor(Math.random() * 256);
  return buffer;
};

const getOrCreateDatabaseKey = () => {
  const storage = getStorage();
  if (!storage) return randomBytes(32);
  const cached = base64ToBytes(storage.getItem(KEY_STORAGE_KEY));
  if (cached?.length === 32) return cached;
  const fresh = randomBytes(32);
  storage.setItem(KEY_STORAGE_KEY, bytesToBase64(fresh));
  return fresh;
};

const getOrCreateClientId = () => {
  const storage = getStorage();
  if (!storage) return randomBytes(16);
  const cached = base64ToBytes(storage.getItem(CLIENT_ID_STORAGE_KEY));
  if (cached?.length === 16) return cached;
  const fresh = randomBytes(16);
  storage.setItem(CLIENT_ID_STORAGE_KEY, bytesToBase64(fresh));
  return fresh;
};

const createStubTransport = () => ({
  async sendCommitBundle() {
    if (import.meta?.env?.DEV) {
      console.warn('[MLS] sendCommitBundle stub transport invoked — backend wiring pending');
    }
    return 'success';
  },
  async sendMessage() {
    if (import.meta?.env?.DEV) {
      console.warn('[MLS] sendMessage stub transport invoked — backend wiring pending');
    }
    return 'success';
  },
  async prepareForTransport(secret) {
    if (!secret?.data) return new MlsTransportData(new Uint8Array());
    return new MlsTransportData(secret.data);
  }
});

const bootstrapCoreCrypto = async () => {
  let wasmOverride;
  if (typeof WASM_BASE === 'string') {
    const trimmed = WASM_BASE.trim();
    if (trimmed.length > 0) {
      wasmOverride = trimmed.endsWith('.wasm')
        ? trimmed
        : `${trimmed.replace(/\/+$/, '')}/core-crypto-ffi_bg.wasm`;
    }
  }

  if (wasmOverride) {
    await initWasmModule(wasmOverride);
  } else {
    await initWasmModule();
  }

  const databaseKey = new DatabaseKey(getOrCreateDatabaseKey());
  const clientId = new ClientId(getOrCreateClientId());
  const params = {
    databaseName: DATABASE_NAME,
    key: databaseKey,
    clientId,
    ciphersuites: [ciphersuiteDefault()]
  };

  const instance = await CoreCrypto.init(params);
  await instance.provideTransport(createStubTransport());
  return instance;
};

export const isMlsEnabled = () => FEATURE_FLAG;

export const getCoreCrypto = async () => {
  if (!FEATURE_FLAG) return null;
  if (coreCryptoInstance) return coreCryptoInstance;
  if (!initPromise) {
    initPromise = bootstrapCoreCrypto()
      .then((instance) => {
        coreCryptoInstance = instance;
        return instance;
      })
      .catch((error) => {
        initPromise = null;
        throw error;
      });
  }
  return initPromise;
};

export const resetCoreCrypto = async () => {
  if (coreCryptoInstance) {
    try {
      await coreCryptoInstance.close?.();
    } catch {}
  }
  coreCryptoInstance = null;
  initPromise = null;
};
