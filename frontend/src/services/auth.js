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

        let unlocked = false;
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
             console.log('Passkey login without vault unlock. Vault remains locked.');
        }

          // Initialize socket AFTER vault operations complete
          // MLS is now ready to handle incoming messages
          socketService.initializeSocket();
      }
    } catch (profileError) {
      console.warn('Error during post-login vault setup:', profileError);
    }

    // Fetch posts in background (don't block navigation)
    getStore('posts').then(postsStore => {
      if (postsStore?.actions?.fetchPosts) {
        postsStore.actions.fetchPosts.call(postsStore);
      }
    }).catch(() => {});
    
    // Navigate to home page after login
    window.location.hash = 'home';
    updatePageFromHash();
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
    
    // Save token and update state
    saveToken(response.token);
    updateAdminStateFromToken();
    
    await onLoginSuccess(password);
    
    return { success: true };
  } catch (error) {
    console.error('Login error:', error);
    return { 
      success: false, 
      error: error.message || 'Login failed. Please check your credentials.'
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
  logout,
  getTokenData,
  isTokenExpired,
  getUserId
};
