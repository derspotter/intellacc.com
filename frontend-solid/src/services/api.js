import { getToken, clearToken } from './tokenService';

const API_BASE = '/api';

export class ApiError extends Error {
    constructor(status, message, data = {}) {
        super(message);
        this.status = status;
        this.data = data;
        this.name = 'ApiError';
    }
}

async function request(endpoint, options = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const config = {
        ...options,
        headers,
    };

    if (options.body && typeof options.body === 'object') {
        config.body = JSON.stringify(options.body);
    }

    try {
        const response = await fetch(`${API_BASE}${endpoint}`, config);

        if (!response.ok) {
            if (response.status === 401) {
                clearToken();
                // Redirect logic can be handled by router or store
            }
            const data = await response.json().catch(() => ({}));
            throw new ApiError(response.status, data.message || 'API Error', data);
        }

        // Handle 204 No Content
        if (response.status === 204) return null;

        return await response.json();
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(0, error.message || 'Network Error', { originalError: error });
    }
}

export const api = {
    auth: {
        login: (email, password) => request('/login', { method: 'POST', body: { email, password } }),
        register: (username, email, password) => request('/users/register', { method: 'POST', body: { username, email, password } }),
        getProfile: () => request('/me'),
        // Staged login flow
        checkDeviceStatus: (email, deviceFingerprint) =>
            request('/auth/check-device-status', { method: 'POST', body: { email, deviceFingerprint } }),
        startPreLoginLink: (sessionToken, email, deviceFingerprint, deviceName) =>
            request('/auth/start-pre-login-link', { method: 'POST', body: { sessionToken, email, deviceFingerprint, deviceName } }),
        getPreLoginLinkStatus: (sessionToken) =>
            request(`/auth/link-status/${sessionToken}`),
    },
    users: {
        getMasterKey: (deviceIds) => request('/users/master-key', {
            headers: deviceIds ? { 'x-device-ids': Array.isArray(deviceIds) ? deviceIds.join(',') : deviceIds } : {}
        }),
        setMasterKey: (wrapped_key, salt, iv) => request('/users/master-key', { method: 'POST', body: { wrapped_key, salt, iv } }),
    },
    posts: {
        getAll: () => request('/posts'),
        create: (content) => request('/posts', { method: 'POST', body: { content } }),
        getComments: (postId) => request(`/posts/${postId}/comments`),
        like: (postId) => request(`/posts/${postId}/like`, { method: 'POST' }),
        unlike: (postId) => request(`/posts/${postId}/like`, { method: 'DELETE' }),
    },
    predictions: {
        getAll: () => request('/predictions'),
        create: (event_id, prediction_value, confidence, prediction_type, numerical_value, lower_bound, upper_bound, prob_vector) =>
            request('/predictions', {
                method: 'POST',
                body: { event_id, prediction_value, confidence, prediction_type, numerical_value, lower_bound, upper_bound, prob_vector }
            }),
        getAssigned: () => request('/predictions/assigned'),
        getBettingStats: () => request('/predictions/betting-stats'),
        placeBet: (assignmentId, confidenceLevel, betOn) =>
            request('/predictions/bet', {
                method: 'POST',
                body: { assignmentId, confidenceLevel, betOn }
            }),
        getByUser: (userId) => request(`/predictions/user/${userId}`),
    },
    events: {
        getAll: (search) => request(search ? `/events?search=${search}` : '/events'),
        create: (data) => request('/events', { method: 'POST', body: data }),
        resolve: (eventId, outcome) => request(`/events/${eventId}/resolve`, { method: 'POST', body: { outcome } }),
    },
    // MLS Messaging endpoints
    mls: {
        getGroups: () => request('/mls/groups'),
        getDirectMessages: () => request('/mls/direct-messages'),
        createDirectMessage: (targetUserId) => request(`/mls/direct-messages/${targetUserId}`, { method: 'POST' }),
        getMessages: (conversationId, options = {}) => {
            const params = new URLSearchParams();
            if (options.limit) params.set('limit', String(options.limit));
            if (options.before) params.set('before', options.before);
            const suffix = params.toString() ? `?${params.toString()}` : '';
            return request(`/mls/messages/${conversationId}${suffix}`);
        },
        getPendingMessages: () => request('/mls/queue/pending'),
        ackMessages: (messageIds) => request('/mls/queue/ack', { method: 'POST', body: { messageIds } }),
    },
    // Users search
    usersSearch: (query) => request(`/users/search?q=${encodeURIComponent(query)}`),
};
