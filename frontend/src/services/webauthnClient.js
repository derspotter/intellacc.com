// frontend/src/services/webauthnClient.js
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import api from './api';
import keyManager from './keyManager.js';
import cryptoService from './crypto';

// Storage keys for wrapped private key
const WRAPPED_KEY_RECORD = 'intellacc_wrapped_private_key';

export async function registerDevice() {
  const options = await api.webauthn.registerStart();
  if (!options || typeof options !== 'object' || !options.challenge) {
    console.error('Invalid registration options from server:', options);
    throw new Error('Failed to start WebAuthn: invalid registration options');
  }
  const attResp = await startRegistration({ optionsJSON: options });
  await api.webauthn.registerFinish(attResp);
  return true;
}

// Wrap current private key and store
export async function wrapPrivateKeyWithPassphrase(passphrase) {
  // Export current private key base64 via keyManager (already in memory)
  if (!keyManager.isUnlocked()) throw new Error('Private key not unlocked');
  // We don't have direct getter; re-export via cryptoService
  // In keyManager, privateKey is CryptoKey; export to base64 and encrypt
  const pkBase64 = await cryptoService.exportPrivateKey(keyManager.privateKey);
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const aesKey = await cryptoService.deriveKey(passphrase, salt);
  const enc = await cryptoService.encryptData(aesKey, pkBase64);
  const record = { salt: cryptoService.bytesToBase64(salt), iv: enc.iv, ciphertext: enc.ciphertext };
  localStorage.setItem(WRAPPED_KEY_RECORD, JSON.stringify(record));
}

// For demo: after successful WebAuthn auth, unwrap using a passphrase provided earlier
export async function unlockWithBiometricsThenPassphrase(passphrase) {
  const options = await api.webauthn.authStart();
  if (!options || typeof options !== 'object' || !options.challenge) {
    console.error('Invalid authentication options from server:', options);
    throw new Error('Failed to start WebAuthn authentication: invalid options');
  }
  const asResp = await startAuthentication({ optionsJSON: options });
  await api.webauthn.authFinish(asResp);
  // Now unwrap
  const raw = localStorage.getItem(WRAPPED_KEY_RECORD);
  if (!raw) throw new Error('No wrapped key stored');
  const record = JSON.parse(raw);
  const salt = cryptoService.base64ToBytes(record.salt);
  const aesKey = await cryptoService.deriveKey(passphrase, salt);
  const plain = await cryptoService.decryptData(aesKey, record.iv, record.ciphertext);
  // Import into keyManager
  keyManager.privateKey = await cryptoService.importPrivateKey(plain);
  return true;
}
