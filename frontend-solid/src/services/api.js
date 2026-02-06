import { getToken, clearToken } from './tokenService';

const API_BASE = '/api';

function getDeviceIdHeader() {
    try {
        const v = localStorage.getItem('device_id') || localStorage.getItem('device_public_id');
        if (!v) return {};
        return { 'x-device-id': v };
    } catch {
        return {};
    }
}

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

async function requestForm(endpoint, formData, options = {}) {
    const token = getToken();
    const headers = {
        ...options.headers
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const config = {
        ...options,
        headers,
        body: formData,
    };

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

async function requestBlob(endpoint, options = {}) {
    const token = getToken();
    const headers = {
        ...options.headers
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const config = {
        ...options,
        headers,
    };

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

        return await response.blob();
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(0, error.message || 'Network Error', { originalError: error });
    }
}

function mlsRequest(endpoint, options = {}) {
    const headers = {
        ...(options.headers || {}),
        ...getDeviceIdHeader(),
    };
    return request(endpoint, { ...options, headers });
}

export const api = {
    auth: {
        login: (email, password) => request('/login', { method: 'POST', body: { email, password } }),
        register: (username, email, password) => request('/users/register', { method: 'POST', body: { username, email, password } }),
        getProfile: () => request('/me'),
        requestPasswordReset: (email) => request('/auth/forgot-password', { method: 'POST', body: { email } }),
        resetPassword: (token, newPassword, acknowledged, devicePublicId) => {
            const body = { token, newPassword, acknowledged };
            if (devicePublicId) body.device_public_id = devicePublicId;
            return request('/auth/reset-password', { method: 'POST', body });
        },
        cancelPasswordReset: () => request('/auth/reset-password/cancel', { method: 'POST' }),
        // Staged login flow
        checkDeviceStatus: (email, deviceFingerprint) =>
            request('/auth/check-device-status', { method: 'POST', body: { email, deviceFingerprint } }),
        startPreLoginLink: (sessionToken, email, deviceFingerprint, deviceName) =>
            request('/auth/start-pre-login-link', { method: 'POST', body: { sessionToken, email, deviceFingerprint, deviceName } }),
        getPreLoginLinkStatus: (sessionToken) =>
            request(`/auth/link-status/${sessionToken}`),
    },
    users: {
        getProfile: () => request('/me'),
        updateProfile: ({ bio, username } = {}) => {
            const body = {};
            if (typeof bio !== 'undefined') body.bio = bio;
            if (typeof username !== 'undefined') body.username = username;
            return request('/users/profile', { method: 'PATCH', body });
        },
        getUser: (id) => request(`/users/${id}`),
        getUserByUsername: (username) => request(`/users/username/${username}`),
        search: (query) => request(`/users/search?q=${encodeURIComponent(query)}`),
        changePassword: (oldPassword, newPassword) =>
            request('/users/change-password', { method: 'POST', body: { oldPassword, newPassword } }),
        deleteAccount: (password) => request('/me', { method: 'DELETE', body: { password } }),
        getMasterKey: (deviceIds) => request('/users/master-key', {
            headers: deviceIds ? { 'x-device-ids': Array.isArray(deviceIds) ? deviceIds.join(',') : deviceIds } : {}
        }),
        setMasterKey: (wrapped_key, salt, iv) => request('/users/master-key', { method: 'POST', body: { wrapped_key, salt, iv } }),
        follow: (id) => request(`/users/${id}/follow`, { method: 'POST' }),
        unfollow: (id) => request(`/users/${id}/follow`, { method: 'DELETE' }),
        getFollowers: (id) => request(`/users/${id}/followers`),
        getFollowing: (id) => request(`/users/${id}/following`),
    },
    posts: {
        getAll: () => request('/posts'),
        getFeed: () => request('/feed'),
        getById: (id) => request(`/posts/${id}`),
        create: (content) => request('/posts', { method: 'POST', body: { content } }),
        createWithImage: (content, image_attachment_id, image_url = null) =>
            request('/posts', { method: 'POST', body: { content, image_attachment_id, image_url } }),
        update: (id, content, image_attachment_id, image_url) => {
            let body = { content };
            if (image_attachment_id && typeof image_attachment_id === 'object' && image_url === undefined) {
                const options = image_attachment_id;
                if (Object.prototype.hasOwnProperty.call(options, 'image_attachment_id')) {
                    body.image_attachment_id = options.image_attachment_id;
                }
                if (Object.prototype.hasOwnProperty.call(options, 'image_url')) {
                    body.image_url = options.image_url;
                }
            } else {
                if (image_attachment_id !== undefined) {
                    body.image_attachment_id = image_attachment_id;
                }
                if (image_url !== undefined) {
                    body.image_url = image_url;
                }
            }
            return request(`/posts/${id}`, { method: 'PATCH', body });
        },
        delete: (id) => request(`/posts/${id}`, { method: 'DELETE' }),
        getComments: (postId) => request(`/posts/${postId}/comments`),
        getCommentTree: (postId, maxDepth = 10) =>
            request(`/posts/${postId}/comments/tree?maxDepth=${maxDepth}`),
        createComment: (parentId, content) =>
            request('/posts', { method: 'POST', body: { content, parent_id: parentId } }),
        updateComment: (commentId, content) =>
            request(`/posts/${commentId}`, { method: 'PATCH', body: { content } }),
        deleteComment: (commentId) =>
            request(`/posts/${commentId}`, { method: 'DELETE' }),
        like: (postId) => request(`/posts/${postId}/like`, { method: 'POST' }),
        unlike: (postId) => request(`/posts/${postId}/like`, { method: 'DELETE' }),
        likePost: (postId) => request(`/posts/${postId}/like`, { method: 'POST' }),
        unlikePost: (postId) => request(`/posts/${postId}/like`, { method: 'DELETE' }),
        getLikeStatus: (postId) => request(`/posts/${postId}/like/status`, { method: 'GET' }),
        getLikesCount: (postId) => request(`/posts/${postId}/likes`, { method: 'GET' }),
    },
    attachments: {
        uploadPost: (file) => {
            const form = new FormData();
            form.append('file', file);
            return requestForm('/attachments/post', form, { method: 'POST' });
        },
        uploadMessage: (file, mlsGroupId) => {
            const form = new FormData();
            form.append('file', file);
            form.append('mls_group_id', mlsGroupId);
            return requestForm('/attachments/message', form, { method: 'POST' });
        },
        download: (attachmentId) => requestBlob(`/attachments/${attachmentId}`)
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
        resolve: (id, outcome) => request(`/predictions/${id}`, { method: 'PATCH', body: { outcome } }),
        placeBet: (assignmentId, confidenceLevel, betOn) =>
            request(`/assignments/${assignmentId}/bet`, {
                method: 'POST',
                body: { confidenceLevel, betOn }
            }),
        getByUser: (userId) => request(`/predictions/user/${userId}`),
    },
    events: {
        getAll: (search) => request(search ? `/events?search=${search}` : '/events'),
        create: (data) => request('/events', { method: 'POST', body: data }),
        resolve: (eventId, outcome) => request(`/events/${eventId}/resolve`, { method: 'POST', body: { outcome } }),
        resolveLegacy: (eventId, outcome) => request(`/events/${eventId}`, { method: 'PATCH', body: { outcome } }),
        // LMSR market trade (proxy to prediction-engine via backend)
        updateMarket: (eventId, stake, target_prob) =>
            request(`/events/${eventId}/update`, { method: 'POST', body: { stake, target_prob } }),
    },
    // MLS Messaging endpoints
    mls: {
        getGroups: () => request('/mls/groups'),
        getDirectMessages: () => request('/mls/direct-messages'),
        createDirectMessage: (targetUserId) => request(`/mls/direct-messages/${targetUserId}`, { method: 'POST' }),
        publishKeyPackages: (body) => mlsRequest('/mls/key-packages', { method: 'POST', body }),
        sendCommitBundle: (body) => mlsRequest('/mls/commit', { method: 'POST', body }),
        sendCoreMessage: (body) => mlsRequest('/mls/message', { method: 'POST', body }),
        sendHistorySecret: (body) => mlsRequest('/mls/history-secret', { method: 'POST', body }),
        migrateConversation: (body) => mlsRequest('/mls/migrate', { method: 'POST', body }),
        getKeyPackages: (userId, { ciphersuite, limit } = {}) => {
            const params = new URLSearchParams();
            if (ciphersuite != null) params.set('ciphersuite', String(ciphersuite));
            if (limit != null) params.set('limit', String(limit));
            const suffix = params.toString() ? `?${params.toString()}` : '';
            return mlsRequest(`/mls/key-packages/${userId}${suffix}`);
        },
        createCredentialRequest: (body) => mlsRequest('/mls/credentials/request', { method: 'POST', body }),
        completeCredential: (body) => mlsRequest('/mls/credentials/complete', { method: 'POST', body }),
        listCredentials: (status) => {
            const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
            return mlsRequest(`/mls/credentials${suffix}`);
        },
        upsertConversation: (body) => mlsRequest('/mls/conversations', { method: 'POST', body }),
        updateGroupInfo: (conversationId, body) =>
            mlsRequest(`/mls/conversations/${conversationId}/group-info`, { method: 'PUT', body }),
        setHistorySharing: (conversationId, body) =>
            mlsRequest(`/mls/conversations/${conversationId}/history-sharing`, { method: 'PUT', body }),
        getConversation: (conversationId) => mlsRequest(`/mls/conversations/${conversationId}`),
        sendMessage: (groupId, messageType, data, epoch, excludeUserIds) => request('/mls/messages/group', {
            method: 'POST',
            body: { groupId, messageType, data, epoch, excludeUserIds },
            // Headers for device ID are handled by the caller or request interceptor if added later
        }),
        getMessages: (conversationId, options = {}) => {
            const params = new URLSearchParams();
            if (options.limit) params.set('limit', String(options.limit));
            if (options.before) params.set('before', options.before);
            const suffix = params.toString() ? `?${params.toString()}` : '';
            return request(`/mls/messages/group/${conversationId}${suffix}`);
        },
        getPendingMessages: () => request('/mls/queue/pending', { headers: getDeviceIdHeader() }),
        ackMessages: (messageIds) => request('/mls/queue/ack', { method: 'POST', headers: getDeviceIdHeader(), body: { messageIds } }),
        syncGroupMembers: (groupId, memberIds) =>
            mlsRequest(`/mls/groups/${encodeURIComponent(groupId)}/members/sync`, { method: 'POST', body: { memberIds } }),
    },
    leaderboard: {
        getGlobal: (limit = 10) => request(`/leaderboard/global?limit=${limit}`),
        getFollowers: (limit = 10) => request(`/leaderboard/followers?limit=${limit}`),
        getFollowing: (limit = 10) => request(`/leaderboard/following?limit=${limit}`),
        getNetwork: (limit = 10) => request(`/leaderboard/network?limit=${limit}`),
        getUserRank: () => request('/leaderboard/rank'),
    },
    scoring: {
        getLeaderboard: (limit = 10) => request(`/scoring/leaderboard?limit=${limit}`),
        getEnhancedLeaderboard: () => request('/scoring/enhanced-leaderboard'),
        getUserReputation: (userId) => request(`/scoring/user/${userId}/reputation`),
        updateUserReputation: (userId) => request(`/scoring/user/${userId}/update-reputation`, { method: 'POST' }),
        getUserAccuracy: (userId) => request(`/scoring/user/${userId}/accuracy`),
        getUserCalibration: (userId) => request(`/scoring/user/${userId}/calibration`),
        getUserBrierScore: (userId) => request(`/scoring/user/${userId}/brier`),
        calculateLogScores: () => request('/scoring/calculate', { method: 'POST' }),
        calculateTimeWeights: () => request('/scoring/time-weights', { method: 'POST' }),
    },
    weekly: {
        getUserStatus: (userId) => request(`/weekly/user/${userId}/status`),
    },
    notifications: {
        getAll: (options = {}) => {
            const { limit = 20, offset = 0, unreadOnly = false } = options;
            const params = new URLSearchParams({
                limit: limit.toString(),
                offset: offset.toString(),
                unreadOnly: unreadOnly.toString()
            });
            return request(`/notifications?${params}`);
        },
        getUnreadCount: () => request('/notifications/count'),
        markAsRead: (notificationId) => request(`/notifications/${notificationId}/read`, { method: 'PUT' }),
        markAllAsRead: () => request('/notifications/mark-all-read', { method: 'PUT' }),
        delete: (notificationId) => request(`/notifications/${notificationId}`, { method: 'DELETE' }),
    },
    push: {
        getVapidKey: () => request('/push/vapid-public-key'),
        subscribe: (subscription) => request('/push/subscribe', { method: 'POST', body: subscription }),
        unsubscribe: (endpoint) => request('/push/subscribe', { method: 'DELETE', body: { endpoint } }),
        getPreferences: () => request('/push/preferences'),
        updatePreferences: (preferences) => request('/push/preferences', { method: 'PUT', body: preferences }),
    },
    keys: {
        storePublicKey: (publicKey) => request('/keys', { method: 'POST', body: { publicKey } }),
        getMyPublicKey: () => request('/keys/me'),
        getUserPublicKey: (userId) => request(`/keys/user/${userId}`),
        getMultiplePublicKeys: (userIds) => request('/keys/batch', { method: 'POST', body: { userIds } }),
        getUsersWithKeys: (limit = 50, offset = 0) => request(`/keys/users?limit=${limit}&offset=${offset}`),
        verifyFingerprint: (userId, fingerprint) => request('/keys/verify', { method: 'POST', body: { userId, fingerprint } }),
        deleteMyPublicKey: () => request('/keys/me', { method: 'DELETE' }),
        getStats: () => request('/keys/stats'),
    },
    messages: {
        getConversations: (limit = 20, offset = 0) =>
            request(`/messages/conversations?limit=${limit}&offset=${offset}`),
        createConversation: (otherUserId, otherUsername) => {
            const body = {};
            if (otherUsername) {
                body.otherUsername = otherUsername;
            } else if (otherUserId) {
                body.otherUserId = otherUserId;
            }
            return request('/messages/conversations', { method: 'POST', body });
        },
        searchConversations: (query, limit = 10) =>
            request(`/messages/conversations/search?q=${encodeURIComponent(query)}&limit=${limit}`),
        getConversation: (conversationId) =>
            request(`/messages/conversations/${conversationId}`),
        getMessages: (conversationId, limit = 50, offset = 0, before = null) => {
            let url = `/messages/conversations/${conversationId}/messages?limit=${limit}&offset=${offset}`;
            if (before) {
                url += `&before=${encodeURIComponent(before)}`;
            }
            return request(url);
        },
        sendMessage: (conversationId, messageData) =>
            request(`/messages/conversations/${conversationId}/messages`, { method: 'POST', body: messageData }),
        markAsRead: (messageIds) =>
            request('/messages/read', { method: 'POST', body: { messageIds } }),
        getUnreadCount: () =>
            request('/messages/unread-count'),
        deleteMessage: (messageId) =>
            request(`/messages/${messageId}`, { method: 'DELETE' }),
    },
    webauthn: {
        registerStart: () => request('/webauthn/register/options', { method: 'POST' }),
        registerFinish: (attestationResponse) =>
            request('/webauthn/register/verify', { method: 'POST', body: attestationResponse }),
        authStart: (body) => request('/webauthn/login/options', { method: 'POST', body }),
        authFinish: (assertionResponse) =>
            request('/webauthn/login/verify', { method: 'POST', body: assertionResponse }),
        credentials: () => request('/webauthn/credentials'),
        deleteCredential: (id) => request(`/webauthn/credentials/${id}`, { method: 'DELETE' }),
    },
    verification: {
        getStatus: () => request('/verification/status'),
        sendEmailVerification: () => request('/auth/verify-email/send', { method: 'POST' }),
        confirmEmailVerification: (token) =>
            request('/auth/verify-email/confirm', { method: 'POST', body: { token } }),
        resendEmailVerification: () => request('/verification/email/resend', { method: 'POST' }),
        startPhoneVerification: (phoneNumber) =>
            request('/verification/phone/start', { method: 'POST', body: { phoneNumber } }),
        confirmPhoneVerification: (phoneNumber, code) =>
            request('/verification/phone/confirm', { method: 'POST', body: { phoneNumber, code } }),
        createPaymentSetup: () =>
            request('/verification/payment/setup', { method: 'POST' }),
    },
    admin: {
        getAiFlags: (params = {}) => {
            const search = new URLSearchParams(params);
            const query = search.toString();
            return request(`/admin/ai-flags${query ? `?${query}` : ''}`);
        },
    },
    devices: {
        list: () => request('/devices'),
        register: (device_public_id, name) =>
            request('/devices/register', { method: 'POST', body: { device_public_id, name } }),
        revoke: (id) => request(`/devices/${id}`, { method: 'DELETE' }),
        startLinking: (device_public_id, name) =>
            request('/devices/link/start', { method: 'POST', body: { device_public_id, name } }),
        approveLinking: (token, approving_device_id) =>
            request('/devices/link/approve', { method: 'POST', body: { token, approving_device_id } }),
        getLinkingStatus: (token) => request(`/devices/link/status?token=${token}`),
    },
    // Users search
    usersSearch: (query) => request(`/users/search?q=${encodeURIComponent(query)}`),
};
