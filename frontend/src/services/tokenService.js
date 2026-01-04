import van from 'vanjs-core';

// Create reactive state for token
export const tokenState = van.state(localStorage.getItem('token') || '');
export const isLoggedInState = van.state(!!localStorage.getItem('token'));

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
}

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

/**
 * Efficiently get user ID with localStorage caching and JWT validation
 */
export function getUserId() {
  const token = getToken();
  if (!token) {
    localStorage.removeItem('userId');
    return null;
  }
  
  const cachedUserId = localStorage.getItem('userId');
  
  try {
    const tokenData = JSON.parse(atob(token.split('.')[1]));
    const tokenUserId = String(tokenData.userId);
    
    if (cachedUserId !== tokenUserId) {
      localStorage.setItem('userId', tokenUserId);
      return tokenUserId;
    }
    return cachedUserId;
  } catch (e) {
    console.error('Invalid token, clearing auth data:', e);
    localStorage.removeItem('userId');
    localStorage.removeItem('token');
    clearToken();
    return null;
  }
}