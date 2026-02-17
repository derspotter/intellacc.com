// src/services/auth.js
import van from 'vanjs-core';
import { api } from './api';
import userStore from '../store/user';
import postsStore from '../store/posts';
import predictionsStore from '../store/predictions';
import { updatePageFromHash } from '../router';
import { getStore } from '../store';
import socketService from './socket';
import coreCryptoClient from './mls/coreCryptoClient';
import vaultStore from '../stores/vaultStore';
import vaultService from './vaultService';
import { initIdleAutoLock, stopIdleAutoLock, loadIdleLockConfig } from './idleLock';
import {
  getToken,
  saveToken, 
  clearToken, 
  getTokenData, 
  isTokenExpired, 
  getUserId,
  isLoggedInState,
  tokenState
} from './tokenService';

// Re-export token states for components that expect them from auth.js
export { isLoggedInState, tokenState, getToken, saveToken, clearToken, getTokenData, isTokenExpired, getUserId };

// Helper to check if error is a device verification requirement
export function isLinkRequiredError(e) {
    return (
        (e.status === 403 && e.data?.code === 'LINK_REQUIRED') ||
        (e.status === 403 && e.message?.includes('Device verification')) ||
        e.message?.includes('Device verification required') ||
        e.data?.code === 'LINK_REQUIRED'
    );
}

export const userProfileState = van.state(null);
export const isAdminState = van.state(false);

const updateAdminStateFromToken = () => {
  const tokenData = getTokenData();
  isAdminState.val = tokenData?.role === 'admin';
};

const getUserFriendlyAuthError = (
  error,
  fallback = 'Login failed. Please check your credentials.'
) => {
  const candidates = [
    error?.message,
    error?.data?.message,
    error?.data?.error
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.replace(/^ApiError:\s*/i, '').trim();
    if (!normalized) {
      continue;
    }

    if (/user not found/i.test(normalized)) {
      return 'User not found';
    }

    if (/incorrect password/i.test(normalized)) {
      return 'Incorrect password';
    }

    return normalized;
  }

  return fallback;
};

/**
 * Reset in-memory authenticated state before replacing an existing session token.
 * This avoids carrying MLS/vault/message state across re-login in the same tab.
 */
const resetSessionStateForRelogin = async () => {
  if (!getToken()) return;

  try {
    await vaultService.lockKeys();
  } catch (e) {
    console.warn('[Auth] Failed to lock vault before re-login:', e);
  }

  vaultStore.reset();
  userStore.actions.reset.call(userStore);
  postsStore.actions.reset.call(postsStore);
  predictionsStore.actions.reset.call(predictionsStore);

  try {
    socketService.disconnect();
  } catch {}
};

/**
 * Check if current user is logged in
 * @returns {boolean} Whether user is logged in
 */
export function checkAuth() {
  const token = getToken();
  if (token) {
    updateAdminStateFromToken();
    // Update user profile after authentication check
    userStore.actions.fetchUserProfile.call(userStore).then(async (profile) => {
      if (profile) {
        // Set vault user context
        vaultStore.setUserId(profile.id);

        // Check vault status on page load
        await vaultService.checkVaultExists(profile.id);
      }
    }).catch(console.error);
    return true;
  }

  isAdminState.val = false;
  return false;
}

// Export for PasskeyButton
export async function onLoginSuccess(password = null) {
    // Fetch user profile after login
    let profile = null;
    try {
      profile = await userStore.actions.fetchUserProfile.call(userStore);
        if (profile) {
          // Set up vault store with user ID
          vaultStore.setUserId(profile.id);

        // Privacy-Preserving Auth Flow:
        // We cannot check if a vault exists without the password (to derive the key/hash).
        // Since we have verified the password via login, we try to unlock.
        // If unlock fails (returns false/throws), it means no vault exists for this user/password combo.
        // So we proceed to setup a new one.
        
        // Device verification now happens during vault unlock. If linking is
        // required, prompt the user to verify this device before unlocking.

        let unlocked = vaultService.isUnlocked();
        let linkRequired = false;

        if (password) {
            try {
                // Try to find and unlock a vault for this user
                await vaultService.unlockWithPassword(password);
                console.log('Vault unlocked automatically');
                unlocked = true;
            } catch (e) {
                if (isLinkRequiredError(e)) {
                    linkRequired = true;
                    vaultStore.setShowDeviceLinkModal(true);
                    console.warn('[Vault] Device verification required before unlock');
                } else {
                    console.log('[Vault] No existing vault found or unlock failed; will create new vault', e.message);
                }
            }
        }

        // Guard against stale local vaults after DB/user resets:
        // if local unlock succeeded but server has no account vault, rebuild locally.
        if (unlocked && password) {
            try {
                const hasAccountVault = await vaultService.hasAccountVault();
                if (!hasAccountVault) {
                    console.warn('[Vault] Local vault unlocked but no server vault exists; rebuilding local keystore');
                    await vaultService.lockKeys();
                    unlocked = false;
                }
            } catch (e) {
                console.warn('[Vault] Failed to verify server vault existence:', e?.message || e);
            }
        }

        if (linkRequired) {
            // Skip vault setup until device is verified.
        } else if (!unlocked && password) {
            // Check if there are ANY vaults (from previous sessions/password)
            const hasVaults = await vaultService.hasLockedVaults();
            if (vaultService.didCreateMasterKey && vaultService.didCreateMasterKey()) {
                // Brand new account: ignore unrelated vaults on this device
                try {
                    await vaultService.setupKeystoreWithPassword(password);
                } catch (e) {
                    if (isLinkRequiredError(e)) {
                        throw new Error('Device verification expired. Please log in again.');
                    }
                    console.error('Vault setup failed:', e);
                }
            } else if (hasVaults) {
                // Vaults exist but unlock failed with correct password.
                // This means the vaults belong to a different user (different userId in encrypted state).
                console.log('Unlock failed but vaults exist (different user). Setting up fresh keystore...');
                try {
                    await vaultService.setupKeystoreWithPassword(password);
                } catch (e) {
                    if (isLinkRequiredError(e)) {
                        throw new Error('Device verification expired. Please log in again.');
                    }
                    console.error('Vault setup failed:', e);
                    vaultStore.setVaultExists(true);
                    vaultStore.setShowMigrationModal(true);
                }
            } else {
                // First time setup on this device
                try {
                    await vaultService.setupKeystoreWithPassword(password);
                } catch (e) {
                    if (isLinkRequiredError(e)) {
                        throw new Error('Device verification expired. Please log in again.');
                    }
                    console.error('Vault setup failed:', e);
                }
            }
        } else if (!unlocked && !password) {
             console.log('[Vault] No password-based unlock available. Prompting for vault passphrase.');
             const hasLocalVaults = await vaultService.hasLockedVaults();
             let hasAccountVault = hasLocalVaults;
             try {
                 hasAccountVault = await vaultService.hasAccountVault();
             } catch (e) {
                 console.warn('[Vault] Failed to check account vault existence:', e?.message || e);
             }
             vaultStore.setVaultExists(hasAccountVault);
             vaultStore.setShowUnlockModal(true);
        }

	      }
	    } catch (profileError) {
	      console.warn('Error during post-login vault setup:', profileError);
	    }
	
	    // Always attempt to initialize the authenticated socket after login.
	    // Even if vault/MLS setup fails (e.g. device verification required), the app
	    // still needs realtime features like feed/predictions/notifications.
	    try {
	      socketService.initializeSocket();
	    } catch (e) {
	      console.warn('Socket init failed after login:', e);
	    }

	    // Fetch posts in background (don't block navigation)
	    getStore('posts').then(postsStore => {
	      if (postsStore?.actions?.fetchPosts) {
	        postsStore.actions.fetchPosts.call(postsStore);
      }
    }).catch(() => {});
    
    // Navigate to home page after login.
    // Let the global `hashchange` listener drive routing to avoid double-renders
    // (and the occasional scroll snap-back on first user scroll).
    window.location.hash = 'home';
}

/**
 * Login with email and password
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} Login result
 */
export async function login(email, password) {
  try {
    console.log('Login attempt with:', email);
    
    if (!email || !password) {
      return { 
        success: false, 
        error: 'Email and password are required'
      };
    }
    
    const response = await api.auth.login(email, password);
    console.log('Login response:', response);
    
    if (!response || !response.token) {
      return { 
        success: false, 
        error: 'Invalid server response'
      };
    }

    // Handle same-tab re-login safely (including account switches) by wiping
    // old in-memory vault/MLS/socket state before swapping the JWT.
    await resetSessionStateForRelogin();
    
    // Save token and update state
    saveToken(response.token);
    updateAdminStateFromToken();
    
    await onLoginSuccess(password);
    
    return { success: true };
  } catch (error) {
    console.error('Login error:', error);
    return { 
      success: false, 
      error: getUserFriendlyAuthError(
        error,
        'Login failed. Please check your credentials.'
      )
    };
  }
}

/**
 * Start Bluesky login via backend OAuth flow
 * @param {string} identifier - Bluesky handle or DID
 * @returns {Promise<Object>} Start result
 */
export async function startAtprotoLogin(identifier) {
  try {
    const normalizedIdentifier = String(identifier || '').trim();
    if (!normalizedIdentifier) {
      return {
        success: false,
        error: 'Bluesky handle or DID is required'
      };
    }

    const response = await api.auth.startAtprotoLogin(normalizedIdentifier, true);
    const authorizationUrl = String(response?.authorizationUrl || '').trim();
    if (!authorizationUrl) {
      return {
        success: false,
        error: 'Unable to start Bluesky login'
      };
    }

    window.location.href = authorizationUrl;
    return { success: true };
  } catch (error) {
    console.error('Start Bluesky login error:', error);
    return {
      success: false,
      error: error.message || 'Unable to start Bluesky login'
    };
  }
}

/**
 * Start Mastodon login via backend OAuth flow
 * @param {string} instance - Mastodon instance domain or URL
 * @returns {Promise<Object>} Start result
 */
export async function startMastodonLogin(instance) {
  try {
    const normalizedInstance = String(instance || '').trim();
    if (!normalizedInstance) {
      return {
        success: false,
        error: 'Mastodon instance is required'
      };
    }

    const response = await api.auth.startMastodonLogin(normalizedInstance, true);
    const authorizationUrl = String(response?.authorizationUrl || '').trim();
    if (!authorizationUrl) {
      return {
        success: false,
        error: 'Unable to start Mastodon login'
      };
    }

    window.location.href = authorizationUrl;
    return { success: true };
  } catch (error) {
    console.error('Start Mastodon login error:', error);
    return {
      success: false,
      error: error.message || 'Unable to start Mastodon login'
    };
  }
}

/**
 * Complete login using a backend-issued social auth token
 * @param {string} token - JWT token from social callback
 * @returns {Promise<Object>} Completion result
 */
export async function completeSocialLogin(token) {
  try {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) {
      return {
        success: false,
        error: 'Missing social login token'
      };
    }

    saveToken(normalizedToken);
    updateAdminStateFromToken();
    await onLoginSuccess(null);
    return { success: true };
  } catch (error) {
    clearToken();
    console.error('Complete social login error:', error);
    return {
      success: false,
      error: error.message || 'Social login failed'
    };
  }
}

/**
 * Register a new user
 * @param {string} username - Username
 * @param {string} email - Email
 * @param {string} password - Password
 * @returns {Promise<Object>} Registration result
 */
export async function register(username, email, password) {
  try {
    if (!username || !email || !password) {
      return { 
        success: false, 
        error: 'Username, email, and password are required'
      };
    }
    
    const user = await api.auth.register(username, email, password);
    if (user?.requiresApproval) {
      return {
        success: true,
        requiresApproval: true,
        message: user.message
      };
    }
    return login(email, password);
  } catch (error) {
    console.error('Registration error:', error);
    return { 
      success: false, 
      error: error.message || 'Registration failed'
    };
  }
}

/**
 * Logout the current user
 * Clears all sensitive data from memory and navigates to login
 */
export async function logout() {
  // Lock vault and wipe crypto keys + decrypted messages from memory
  try {
    await vaultService.lockKeys();
  } catch (e) {
    console.warn('Error locking vault on logout:', e);
  }

  // Reset all stores
  vaultStore.reset();
  userStore.actions.reset.call(userStore);
  postsStore.actions.reset.call(postsStore);
  predictionsStore.actions.reset.call(predictionsStore);

  // Clear auth state
  clearToken();
  userProfileState.val = null;
  isAdminState.val = false;

  // Disconnect socket
  try { socketService.disconnect(); } catch {}

  // Navigate to login page
  window.location.hash = 'login';
}

export default {
  isLoggedInState,
  tokenState,
  userProfileState,
  isAdminState,
  getToken,
  saveToken,
  clearToken,
  checkAuth,
  login,
  register,
  startAtprotoLogin,
  startMastodonLogin,
  completeSocialLogin,
  logout,
  getTokenData,
  isTokenExpired,
  getUserId
};
