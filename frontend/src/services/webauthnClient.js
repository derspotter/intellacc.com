// frontend/src/services/webauthnClient.js
// WebAuthn client - legacy keyManager code removed

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import api from './api';

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

export async function authenticateDevice() {
  const options = await api.webauthn.authStart();
  if (!options || typeof options !== 'object' || !options.challenge) {
    console.error('Invalid authentication options from server:', options);
    throw new Error('Failed to start WebAuthn authentication: invalid options');
  }
  const asResp = await startAuthentication({ optionsJSON: options });
  await api.webauthn.authFinish(asResp);
  return true;
}
