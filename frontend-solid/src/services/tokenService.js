import { createSignal } from 'solid-js';

// Create reactive state for token
const [token, setToken] = createSignal(localStorage.getItem('token') || '');
const [isLoggedIn, setIsLoggedIn] = createSignal(!!localStorage.getItem('token'));
const [userData, setUserData] = createSignal(null);

// Fetch full profile from backend to supplement token data
async function refreshProfile() {
    const t = token();
    if (!t) return;
    try {
        const res = await fetch('/api/me', {
            headers: { 'Authorization': `Bearer ${t}` }
        });
        if (res.ok) {
            const profile = await res.json();
            setUserData(prev => ({ ...prev, ...profile }));
        }
    } catch (e) {
        console.warn('Failed to refresh profile', e);
    }
}

// Initialize user data if token exists
const initialToken = token();
if (initialToken) {
    try {
        const payload = JSON.parse(atob(initialToken.split('.')[1]));
        if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) {
            throw new Error("Token expired or invalid");
        }
        setUserData(payload);
        setIsLoggedIn(true);
    } catch (e) {
        console.warn("Invalid token detected, clearing session", e);
        localStorage.removeItem('token');
        setToken('');
        setIsLoggedIn(false);
        setUserData(null);
    }
} else {
    setIsLoggedIn(false);
}

export { token, isLoggedIn, userData };

/**
 * Get the current authentication token
 * @returns {string|null} JWT token or null
 */
export function getToken() {
    return token();
}

/**
 * Save token to localStorage and update state
 * @param {string} newToken - JWT token
 */
export function saveToken(newToken) {
    if (!newToken) return;
    try {
        const payload = JSON.parse(atob(newToken.split('.')[1]));
        localStorage.setItem('token', newToken);
        setToken(newToken);
        setUserData(payload);
        setIsLoggedIn(true);
        refreshProfile(); // Fetch full details
    } catch (e) {
        console.error("Refusing to save invalid token", e);
        clearToken();
    }
}

/**
 * Clear token from localStorage and update state
 */
export function clearToken() {
    localStorage.removeItem('token');
    setToken('');
    setIsLoggedIn(false);
    setUserData(null);

    // Use dynamic import to avoid circular dependency (tokenService -> vaultService -> api -> tokenService)
    import('./mls/vaultService').then(module => {
        try {
            module.default.lock();
        } catch (e) {
            console.warn('Failed to lock vault on logout', e);
        }
    }).catch(err => console.error("Failed to load vaultService for locking", err));
}

/**
 * Get JWT payload data
 * @returns {Object|null} Decoded JWT payload or null
 */
export function getTokenData() {
    const currentToken = getToken();
    if (!currentToken) return null;

    try {
        const payload = JSON.parse(atob(currentToken.split('.')[1]));
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
    return payload.exp * 1000 < Date.now();
}

export function getUserId() {
    const t = getToken();
    if (!t) return null;
    try {
        const data = getTokenData();
        return data?.userId ? String(data.userId) : null;
    } catch {
        return null;
    }
}

// Fetch full profile from backend to supplement token data

