// src/services/auth.js
import van from 'vanjs-core';
import { api } from './api';
import userStore from '../store/user';
import { updatePageFromHash } from '../router'; // Import updatePageFromHash
import { getStore } from '../store';

// Create reactive state for auth
export const isLoggedInState = van.state(!!localStorage.getItem('token'));
export const tokenState = van.state(localStorage.getItem('token') || '');
export const userProfileState = van.state(null);
export const isAdminState = van.state(false);

/**
 * Get the current authentication token
 * @returns {string|null} JWT token or null
 */
export function getToken() {
  return tokenState.val;
}

/**
 * Save token to localStorage and update state
 * @param {string} token - JWT token
 */
export function saveToken(token) {
  localStorage.setItem('token', token);
  tokenState.val = token;
  isLoggedInState.val = true;
}

/**
 * Clear token from localStorage and update state
 */
export function clearToken() {
  localStorage.removeItem('token');
  tokenState.val = '';
  isLoggedInState.val = false;
  isAdminState.val = false;
}

/**
 * Check if current user is logged in
 * @returns {boolean} Whether user is logged in
 */
export function checkAuth() {
  const token = localStorage.getItem('token');
  if (token) {
    tokenState.val = token;
    isLoggedInState.val = true;
    
    // Update user profile after authentication check
    userStore.actions.fetchUserProfile.call(userStore);
    return true;
  }
  
  isLoggedInState.val = false;
  isAdminState.val = false;
  return false;
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
    
    // Fetch user profile after login
    try {
      await userStore.actions.fetchUserProfile.call(userStore);
    } catch (profileError) {
      console.warn('Could not fetch profile after login:', profileError);
      // Continue with login success even if profile fetch fails
    }

    // Fetch posts after login
    try {
      const postsStore = await getStore('posts'); // Get the posts store instance
      // Ensure store is loaded before calling action
      if (postsStore && postsStore.actions && postsStore.actions.fetchPosts) {
        await postsStore.actions.fetchPosts.call(postsStore);
      } else {
        console.error("Posts store or fetchPosts action not available after login.");
      }
    } catch (postsError) {
      console.warn('Could not fetch posts after login:', postsError);
    }
    
    // Navigate to home page after login
    window.location.hash = 'home';
    // Explicitly call updatePageFromHash to ensure page state and data are loaded
    updatePageFromHash();
    
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
    console.log('Registration attempt with:', { username, email });
    
    if (!username || !email || !password) {
      return { 
        success: false, 
        error: 'Username, email, and password are required'
      };
    }
    
    const user = await api.auth.register(username, email, password);
    console.log('Registration response:', user);
    
    // Login after successful registration
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
 */
export function logout() {
  clearToken();
  userProfileState.val = null;
  
  // Navigate to login page
  window.location.hash = 'login';
}

// fetchUserProfile has been moved to userStore.actions.fetchUserProfile

/**
 * Get JWT payload data
 * @returns {Object|null} Decoded JWT payload or null
 */
export function getTokenData() {
  const token = getToken();
  if (!token) return null;
  
  try {
    // Decode the payload part of the JWT (second segment)
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload;
  } catch (e) {
    console.error('Error decoding token:', e);
    return null;
  }
}

/**
 * Check if token is expired
 * @returns {boolean} Whether token is expired
 */
export function isTokenExpired() {
  const payload = getTokenData();
  if (!payload || !payload.exp) return true;
  
  // exp is in seconds, Date.now() is in milliseconds
  return payload.exp * 1000 < Date.now();
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
  // fetchUserProfile is now provided by userStore.actions.fetchUserProfile
  getTokenData,
  isTokenExpired
};