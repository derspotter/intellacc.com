import { api } from './api';
import { clearToken as clearStoredToken, saveToken as persistToken, getTokenData as readTokenData } from './tokenService';

export const getStoredToken = () => {
  try {
    return localStorage.getItem('token') || null;
  } catch {
    return null;
  }
};

const emitAuthChanged = () => {
  try {
    window?.dispatchEvent?.(new Event('solid-auth-changed'));
  } catch {
    // Ignore environments where Event dispatch fails.
  }
};

export const saveToken = (token) => {
  if (!token) {
    return;
  }

  persistToken(token);
  emitAuthChanged();
};

export const clearToken = () => {
  clearStoredToken();
  emitAuthChanged();
};

export const getTokenData = () => {
  return readTokenData();
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

export const login = (email, password) => api.auth.login(email, password);

export const register = (username, email, password) => api.auth.register(username, email, password);

export const forgotPassword = (email) => api.auth.requestPasswordReset(email);

export const resetPassword = (token, newPassword, acknowledged = false) =>
  api.auth.resetPassword(token, newPassword, acknowledged);

export const logout = () => {
  clearToken();
  window.location.hash = 'login';
};
