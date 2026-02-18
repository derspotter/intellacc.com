const DEFAULT_API_BASE = 'http://127.0.0.1:3005/api';

const configuredBase = () => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) {
    return String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, '');
  }
  return null;
};

const resolveApiBase = () => {
  const fromEnv = configuredBase();
  if (fromEnv) {
    return fromEnv;
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api`;
  }

  return DEFAULT_API_BASE;
};

const request = async (endpoint, options = {}) => {
  const token = localStorage.getItem('token');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const config = {
    ...options,
    headers,
    cache: 'no-store'
  };

  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${resolveApiBase()}${endpoint}`, config);
  if (!response.ok) {
    const message = `Request failed: ${response.status}`;
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const getPosts = (limit = 20) => {
  return request(`/posts?limit=${Number(limit)}`);
};

export const getHealth = () => request('/health');
