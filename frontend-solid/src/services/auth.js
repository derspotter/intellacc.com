import { authLogin, registerUser } from './api';

const decodeBase64Url = (b64url) => {
  if (!b64url) {
    return '';
  }

  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = `${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`;
  return atob(padded);
};

export const getStoredToken = () => {
  try {
    return localStorage.getItem('token') || null;
  } catch {
    return null;
  }
};

export const saveToken = (token) => {
  if (!token) {
    return;
  }

  try {
    localStorage.setItem('token', token);
    window?.dispatchEvent?.(new Event('solid-auth-changed'));
  } catch {
    // Ignore localStorage failures in strict browser/privacy modes.
  }
};

export const clearToken = () => {
  try {
    localStorage.removeItem('token');
    window?.dispatchEvent?.(new Event('solid-auth-changed'));
  } catch {
    // Ignore localStorage failures in strict browser/privacy modes.
  }
};

export const getTokenData = () => {
  const token = getStoredToken();
  if (!token) {
    return null;
  }

  try {
    const [, payload] = token.split('.');
    return JSON.parse(decodeBase64Url(payload));
  } catch (error) {
    console.error('Failed to decode auth token:', error);
    return null;
  }
};

export const getCurrentUserId = () => {
  const tokenData = getTokenData();
  if (!tokenData?.userId) {
    return null;
  }
  return String(tokenData.userId);
};

export const isAdmin = () => {
  const tokenData = getTokenData();
  return tokenData?.role === 'admin';
};

export const isAuthenticated = () => {
  return !!getStoredToken();
};

export const login = (email, password) => authLogin(email, password);

export const register = (username, email, password) =>
  registerUser(username, email, password);

export const logout = () => {
  clearToken();
  window.location.hash = 'login';
};
