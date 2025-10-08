// frontend/src/services/mls/coreCryptoClient.js
// Thin bootstrap wrapper around @wireapp/core-crypto guarded by an MLS feature flag.

import {
  CoreCrypto,
  DatabaseKey,
  ClientId,
  ConversationId,
  CredentialType,
  MlsTransportData,
  ciphersuiteDefault,
  initWasmModule,
  openDatabase
} from '@wireapp/core-crypto';
import { api, ApiError } from '../api.js';

const FEATURE_FLAG = String(import.meta.env.VITE_ENABLE_MLS ?? '').toLowerCase() === 'true';
const WASM_BASE = import.meta.env.VITE_CORE_CRYPTO_WASM_BASE;
const DATABASE_NAME = 'intellacc-mls-keystore';
const KEY_STORAGE_KEY = 'intellacc.mls.databaseKey';
const CLIENT_ID_STORAGE_KEY = 'intellacc.mls.clientId';
const KEYPACKAGE_UPLOAD_TS_KEY = 'intellacc.mls.keypackages.lastUploadTs';

const DEFAULT_CIPHERSUITE = ciphersuiteDefault();
const DEFAULT_KEYPACKAGE_TARGET = Number(import.meta.env.VITE_MLS_KEYPACKAGE_TARGET ?? 5);
const KEYPACKAGE_UPLOAD_MIN_INTERVAL_MS = Number(import.meta.env.VITE_MLS_KEYPACKAGE_UPLOAD_INTERVAL_MS ?? (6 * 60 * 60 * 1000)); // default 6h

const textEncoder = new TextEncoder();

let coreCryptoInstance = null;
let initPromise = null;
let bootstrapPromise = null;

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

  const keyMaterial = getOrCreateDatabaseKey();

  // Ensure the encrypted keystore exists before initializing CoreCrypto. `openDatabase`
  // consumes the provided DatabaseKey instance, so instantiate it with a copy of the bytes.
  await openDatabase(DATABASE_NAME, new DatabaseKey(keyMaterial.slice()));

  const databaseKey = new DatabaseKey(keyMaterial.slice());
  const clientId = new ClientId(getOrCreateClientId());
  const params = {
    databaseName: DATABASE_NAME,
    key: databaseKey,
    clientId,
    ciphersuites: [DEFAULT_CIPHERSUITE]
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

const shouldSkipKeyPackageUpload = () => {
  const storage = getStorage();
  if (!storage) return false;
  const last = Number(storage.getItem(KEYPACKAGE_UPLOAD_TS_KEY) || 0);
  if (!last) return false;
  return (Date.now() - last) < KEYPACKAGE_UPLOAD_MIN_INTERVAL_MS;
};

const markKeyPackagesUploaded = () => {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(KEYPACKAGE_UPLOAD_TS_KEY, String(Date.now()));
};

export const ensureMlsBootstrap = async () => {
  if (!FEATURE_FLAG) return null;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const coreCrypto = await getCoreCrypto();
    if (!coreCrypto) return null;

    const clientIdBytes = getOrCreateClientId();
    const clientIdB64 = bytesToBase64(clientIdBytes);
    const shouldPublish = !shouldSkipKeyPackageUpload();
    const result = await coreCrypto.transaction(async (ctx) => {
      // Touch the client's public key so that a basic credential exists.
      await ctx.clientPublicKey(DEFAULT_CIPHERSUITE, CredentialType.Basic);

      const currentCountBigInt = await ctx.clientValidKeypackagesCount(DEFAULT_CIPHERSUITE, CredentialType.Basic);
      const currentCount = Number(currentCountBigInt ?? 0);
      const target = Math.max(DEFAULT_KEYPACKAGE_TARGET, 1);
      if (currentCount >= target && !shouldPublish) {
        return { generated: [] };
      }

      const amountRequested = Math.max(target - currentCount, shouldPublish ? target : 0);
      if (amountRequested <= 0) {
        return { generated: [] };
      }

      const generated = await ctx.clientKeypackages(DEFAULT_CIPHERSUITE, CredentialType.Basic, amountRequested);
      return { generated };
    });

    const generated = result?.generated || [];
    if (generated.length && shouldPublish) {
      const payload = generated.map(bytesToBase64);
      try {
        await api.mls.publishKeyPackages({
          clientId: clientIdB64,
          ciphersuite: DEFAULT_CIPHERSUITE,
          credentialType: 'basic',
          keyPackages: payload
        });
        markKeyPackagesUploaded();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          // Backend not ready yet; surface as a warning but don't fail the bootstrap.
          if (import.meta?.env?.DEV) {
            console.warn('[MLS] Key package publish endpoint missing (404).', error);
          }
        } else {
          console.warn('[MLS] Failed to publish key packages:', error?.message || error);
          throw error;
        }
      }
    }
    return null;
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });
  return bootstrapPromise;
};

export const getClientIdBase64 = () => bytesToBase64(getOrCreateClientId());

const encodeConversationId = (conversationId) => {
  if (conversationId instanceof Uint8Array) return conversationId;
  return textEncoder.encode(String(conversationId));
};

export const createConversationId = (conversationId) => new ConversationId(encodeConversationId(conversationId));

export const base64ToUint8 = (value) => base64ToBytes(value);
export const uint8ToBase64 = (bytes) => bytesToBase64(bytes);
export const DEFAULT_MLS_CIPHERSUITE = DEFAULT_CIPHERSUITE;
