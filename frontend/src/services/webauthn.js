import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { api } from './api';

export const webauthnService = {
    isAvailable: async () => {
        return typeof window !== 'undefined' && 
               !!window.PublicKeyCredential &&
               (await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    },

    register: async (name, prfInput = null) => {
        // 1. Get options from server
        const options = await api.webauthn.registerStart();
        
        const challenge = options.challenge;
        const registrationPrfInput = prfInput || options?.extensions?.prf?.eval?.first || null;
        
        // Add PRF extension if we have prfInput (which we should for keystore wrapping)
        if (registrationPrfInput) {
            options.extensions = {
                ...options.extensions,
                prf: {
                    eval: {
                        first: registrationPrfInput
                    }
                }
            };
        }

        // 2. Perform ceremony
        const response = await startRegistration(options);
        
        // 3. Verify
        const body = {
            ...response,
            name,
            challenge // Send it back so server can verify
        };

        const result = await api.webauthn.registerFinish(body);
        
        // Return PRF result if available
        const prfResults = response.clientExtensionResults?.prf?.results?.first;
        return {
            ...result,
            prfOutput: prfResults ? new Uint8Array(prfResults) : null,
            prfInput: registrationPrfInput || null
        };
    },

    login: async (email, prfInput = null) => {
        // 1. Get options
        const options = await api.webauthn.authStart(email ? { email } : {});
        
        const challenge = options.challenge;

        // Add PRF eval if input provided
        if (prfInput) {
            options.extensions = {
                ...options.extensions,
                prf: {
                    eval: {
                        first: prfInput
                    }
                }
            };
        }

        // 2. Perform ceremony
        const response = await startAuthentication(options);
        
        // 3. Verify
        const body = {
            ...response,
            challenge
        };

        const result = await api.webauthn.authFinish(body);
        
        // Return PRF output if available
        const prfResults = result.prfOutput ? new Uint8Array(result.prfOutput) : null;
        const fallbackPrfResults = response.clientExtensionResults?.prf?.results?.first
            ? new Uint8Array(response.clientExtensionResults.prf.results.first)
            : null;
        return {
            ...result,
            prfOutput: prfResults || fallbackPrfResults
        };
    },
    
    getCredentials: async () => {
        return await api.webauthn.credentials();
    },
    
    deleteCredential: async (id) => {
        return await api.webauthn.deleteCredential(id);
    }
};
