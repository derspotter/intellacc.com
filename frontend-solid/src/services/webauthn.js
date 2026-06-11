import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api';

const coercePrfOutput = (value) => {
  if (!value) {
    return null;
  }

  try {
    return new Uint8Array(value);
  } catch {
    return null;
  }
};

const stripPrfResults = (response) => {
  const sanitized = { ...response };
  const prfEnabled = response.clientExtensionResults?.prf?.enabled;

  if (typeof prfEnabled === 'boolean') {
    sanitized.clientExtensionResults = {
      prf: { enabled: prfEnabled }
    };
  } else {
    delete sanitized.clientExtensionResults;
  }

  return sanitized;
};

export const webauthnService = {
  isAvailable: async () => {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      return false;
    }

    try {
      if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
        return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      }
      return true;
    } catch (error) {
      console.warn('[webauthnService] Availability check failed:', error);
      return false;
    }
  },

  register: async (name, prfInput = null) => {
    const options = await api.webauthn.registerStart();
    const challenge = options.challenge;
    const registrationPrfInput = prfInput || options?.extensions?.prf?.eval?.first || null;

    if (registrationPrfInput) {
      options.extensions = {
        ...(options.extensions || {}),
        prf: {
          eval: {
            first: registrationPrfInput
          }
        }
      };
    }

    const response = await startRegistration(options);
    const prfOutput = coercePrfOutput(response.clientExtensionResults?.prf?.results?.first);
    const result = await api.webauthn.registerFinish({
      ...stripPrfResults(response),
      name,
      challenge
    });

    return {
      ...result,
      prfOutput,
      prfInput: registrationPrfInput || null
    };
  },

  login: async (email, prfInput = null) => {
    const options = await api.webauthn.authStart(email ? { email } : {});
    const challenge = options.challenge;

    if (prfInput) {
      options.extensions = {
        ...(options.extensions || {}),
        prf: {
          eval: {
            first: prfInput
          }
        }
      };
    }

    const response = await startAuthentication(options);
    const prfOutput = coercePrfOutput(response.clientExtensionResults?.prf?.results?.first);
    const result = await api.webauthn.authFinish({
      ...stripPrfResults(response),
      challenge
    });

    return {
      ...result,
      prfOutput
    };
  },

  getCredentials: async () => {
    return api.webauthn.credentials();
  },

  deleteCredential: async (id) => {
    return api.webauthn.deleteCredential(id);
  }
};

export default webauthnService;
