// Single source of truth for hash routes, shared by the van and terminal
// skins so deep links mean the same thing in both.

export const ROUTES = {
  home: 'home',
  login: 'login',
  signup: 'signup',
  'forgot-password': 'forgot-password',
  'reset-password': 'reset-password',
  profile: 'profile',
  user: 'user',
  predictions: 'predictions',
  analytics: 'analytics',
  network: 'network',
  groups: 'groups',
  group: 'group',
  messages: 'messages',
  notifications: 'notifications',
  settings: 'settings',
  'verify-email': 'verify-email',
  search: 'search',
  // Optional chaining keeps this importable outside Vite (node --test).
  ...(import.meta.env?.DEV ? { __harness: '__harness' } : {})
};

export const NOT_FOUND_ROUTE = 'notFound';

export const AUTH_ROUTES = [
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'verify-email'
];

export const normalizeHashPath = (raw) => {
  const value = (raw || '').replace(/^#/, '').trim();
  if (!value || value.startsWith('?')) {
    return 'home';
  }

  const [path] = value.split('?');
  const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');

  return normalized || 'home';
};

export const sanitizeRoute = (raw) => {
  const route = normalizeHashPath(raw).split('/')[0];
  return ROUTES[route] || NOT_FOUND_ROUTE;
};

export const parseHashRoute = (hashValue) => {
  const value = normalizeHashPath(hashValue);
  const [route, param] = value.split('/');

  if (route === 'user' && !param) {
    return { page: NOT_FOUND_ROUTE, param: null };
  }

  return { page: ROUTES[route] || NOT_FOUND_ROUTE, param: param || null };
};
