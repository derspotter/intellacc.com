// frontend/src/services/signalKeyManager.js
// Scaffolding for Signal (libsignal) key provisioning/publish/fetch

import api from './api.js';
import signalLib from './signalLib.js';

const DEFAULT_DEVICE_ID = 'default';

const signalKeyManager = {
  // Publish identity + signing public keys (base64 strings)
  async publishIdentity(identityKeyBase64, signingKeyBase64, deviceId = DEFAULT_DEVICE_ID) {
    if (!identityKeyBase64 || !signingKeyBase64) {
      throw new Error('identityKey and signingKey are required');
    }
    return await api.e2ee.publishIdentity(identityKeyBase64, signingKeyBase64, deviceId);
  },

  // Publish new signed prekey and a batch of one-time prekeys
  async publishPrekeys({ signedPreKey, oneTimePreKeys = [], deviceId = DEFAULT_DEVICE_ID } = {}) {
    if (!signedPreKey && (!oneTimePreKeys || oneTimePreKeys.length === 0)) {
      throw new Error('signedPreKey or oneTimePreKeys required');
    }
    return await api.e2ee.publishPrekeys(signedPreKey || null, oneTimePreKeys || [], deviceId);
  },

  // Fetch a bundle for a target user/device (identity, signed prekey, optionally one-time prekey)
  async getBundle(userId, deviceId = DEFAULT_DEVICE_ID) {
    if (!userId) throw new Error('userId required');
    return await api.e2ee.getBundle(userId, deviceId);
  }
};

// Convenience helpers to generate and publish using libsignal when present
export async function generateAndPublishIdentity() {
  const { identityKey, signingKey } = await signalLib.generateIdentity();
  await signalKeyManager.publishIdentity(identityKey, signingKey);
  return { identityKey, signingKey };
}

export async function topUpPrekeysIfNeeded(threshold = 20, batch = 50) {
  const { signedPreKey, oneTimePreKeys } = await signalLib.generatePrekeys(batch);
  await signalKeyManager.publishPrekeys({ signedPreKey, oneTimePreKeys });
  return { signedPreKey, oneTimePreKeys };
}

export default signalKeyManager;
