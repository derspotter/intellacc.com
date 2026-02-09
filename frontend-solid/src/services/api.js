// src/services/api.js
import { getToken, clearToken } from './tokenService';
import { getDeviceId } from './deviceIdStore';

// Base API URL
const API_BASE = '/api';

/**
 * Custom API error class
 */
export class ApiError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = 'ApiError';
  }
}

/**
 * Make an API request
 * @param {string} endpoint - API endpoint
 * @param {Object} options - Request options
 * @returns {Promise<any>} Response data
 * @throws {ApiError} API error
 */
async function request(endpoint, options = {}) {
  // Get authentication token
  const token = getToken();

  // Set up headers
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };



  // Add authentication if token exists
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }


  // Configure request
  const config = {
    ...options,
    headers,
    // Prevent caching
    cache: 'no-store'
  };

  // Convert body to JSON if it's an object
  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }

  try {
    // Make the request
    const response = await fetch(`${API_BASE}${endpoint}`, config);

    // Handle unsuccessful responses
    if (!response.ok) {
      // Handle authentication errors
      if (response.status === 401) {
        // Try to parse error response
        try {
          const errorData = await response.json();
          console.log('Authentication error:', errorData);

          // Clear token on authentication failure
          clearToken();

          // Show a notification to the user (if available)
          if (window.showNotification) {
            window.showNotification('Session expired. Please log in again.', 'error');
          }

          // Redirect to login
          window.location.hash = 'login';

          throw new ApiError(
            response.status,
            errorData.message || 'Session expired. Please log in again.',
            errorData
          );
        } catch (e) {
          // If parsing fails, proceed with generic handling
          clearToken();
          window.location.hash = 'login';
          throw new ApiError(response.status, 'Session expired. Please log in again.');
        }
      }

      // Try to parse error response
      let errorMessage = 'An error occurred';
      let errorData = {};

      try {
        const errorResponse = await response.json();
        errorMessage = errorResponse.message || errorResponse.error || errorMessage;
        errorData = errorResponse;
      } catch (e) {
        // If not JSON, try to get text
        try {
          errorMessage = await response.text() || errorMessage;
        } catch {
          // Fallback if text retrieval fails
        }
      }

      throw new ApiError(response.status, errorMessage, errorData);
    }

    // Parse JSON response (handle empty responses)
    try {
      return await response.json();
    } catch (e) {
      return null;
    }
  } catch (error) {
    // Rethrow ApiError instances
    if (error instanceof ApiError) {
      throw error;
    }

    // Convert fetch errors to ApiError
    throw new ApiError(
      0, // Network error
      error.message || 'Network error',
      { originalError: error }
    );
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
    cache: 'no-store'
  };

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, config);

    if (!response.ok) {
      if (response.status === 401) {
        try {
          const errorData = await response.json();
          clearToken();
          if (window.showNotification) {
            window.showNotification('Session expired. Please log in again.', 'error');
          }
          window.location.hash = 'login';
          throw new ApiError(
            response.status,
            errorData.message || 'Session expired. Please log in again.',
            errorData
          );
        } catch (e) {
          clearToken();
          window.location.hash = 'login';
          throw new ApiError(response.status, 'Session expired. Please log in again.');
        }
      }

      let errorMessage = 'An error occurred';
      let errorData = {};

      try {
        const errorResponse = await response.json();
        errorMessage = errorResponse.message || errorResponse.error || errorMessage;
        errorData = errorResponse;
      } catch (e) {
        try {
          errorMessage = await response.text() || errorMessage;
        } catch {
        }
      }

      throw new ApiError(response.status, errorMessage, errorData);
    }

    try {
      return await response.json();
    } catch (e) {
      return null;
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      0,
      error.message || 'Network error',
      { originalError: error }
    );
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
    cache: 'no-store'
  };

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, config);

    if (!response.ok) {
      if (response.status === 401) {
        try {
          const errorData = await response.json();
          clearToken();
          if (window.showNotification) {
            window.showNotification('Session expired. Please log in again.', 'error');
          }
          window.location.hash = 'login';
          throw new ApiError(
            response.status,
            errorData.message || 'Session expired. Please log in again.',
            errorData
          );
        } catch (e) {
          clearToken();
          window.location.hash = 'login';
          throw new ApiError(response.status, 'Session expired. Please log in again.');
        }
      }

      let errorMessage = 'An error occurred';
      let errorData = {};

      try {
        const errorResponse = await response.json();
        errorMessage = errorResponse.message || errorResponse.error || errorMessage;
        errorData = errorResponse;
      } catch (e) {
        try {
          errorMessage = await response.text() || errorMessage;
        } catch {
        }
      }

      throw new ApiError(response.status, errorMessage, errorData);
    }

    return await response.blob();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      0,
      error.message || 'Network error',
      { originalError: error }
    );
  }
}

function mlsRequest(endpoint, options = {}) {
  const deviceId = getDeviceId();
  if (!deviceId) return request(endpoint, options);

  const headers = {
    ...(options.headers || {}),
    'x-device-id': deviceId
  };
  return request(endpoint, { ...options, headers });
}

/**
 * API client methods
 */
export const api = {
  // Auth endpoints
  auth: {
    login: (email, password) =>
      request('/login', { method: 'POST', body: { email, password } }),

    register: (username, email, password) =>
      request('/users/register', { method: 'POST', body: { username, email, password } }),

    requestPasswordReset: (email) =>
      request('/auth/forgot-password', { method: 'POST', body: { email } }),

    resetPassword: (token, newPassword, acknowledged, devicePublicId) => {
      const body = { token, newPassword, acknowledged };
      if (devicePublicId) body.device_public_id = devicePublicId;
      return request('/auth/reset-password', { method: 'POST', body });
    },

    cancelPasswordReset: () =>
      request('/auth/reset-password/cancel', { method: 'POST' })
  },

  // Users endpoints
  users: {
    getProfile: () =>
      request('/me'),

    updateProfile: ({ bio, username } = {}) => {
      const body = {};
      if (typeof bio !== 'undefined') body.bio = bio;
      if (typeof username !== 'undefined') body.username = username;
      return request('/users/profile', { method: 'PATCH', body });
    },

    getUser: (id) =>
      request(`/users/${id}`),

    getUserByUsername: (username) =>
      request(`/users/username/${username}`),

    search: (query) =>
      request(`/users/search?q=${encodeURIComponent(query)}`),

    changePassword: (oldPassword, newPassword) =>
      request('/users/change-password', { method: 'POST', body: { oldPassword, newPassword } }),

    deleteAccount: (password) =>
      request('/me', { method: 'DELETE', body: { password } }),

    getMasterKey: (deviceIds) =>
      request('/users/master-key', {
          headers: deviceIds ? { 'x-device-ids': deviceIds.join(',') } : {}
      }),

    setMasterKey: (wrapped_key, salt, iv) =>
      request('/users/master-key', { method: 'POST', body: { wrapped_key, salt, iv } }),

    follow: (id) =>
      request(`/users/${id}/follow`, { method: 'POST' }),

    unfollow: (id) =>
      request(`/users/${id}/follow`, { method: 'DELETE' }),

    getFollowers: (id) =>
      request(`/users/${id}/followers`),

    getFollowing: (id) =>
      request(`/users/${id}/following`)
  },

  // Posts endpoints
  posts: {
    getAll: () =>
      request('/posts'),

    getFeed: () =>
      request('/feed'),

    getPage: ({ cursor = null, limit = 20 } = {}) => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      return request(`/posts?${params.toString()}`);
    },

    getFeedPage: ({ cursor = null, limit = 20 } = {}) => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      return request(`/feed?${params.toString()}`);
    },

    getById: (id) =>
      request(`/posts/${id}`),

    create: (content, image_attachment_id, image_url = null) =>
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

    delete: (id) =>
      request(`/posts/${id}`, { method: 'DELETE' }),

    /**
     * Get direct comments for a post
     */
    getComments: (postId) =>
      request(`/posts/${postId}/comments`),

    /**
     * Get nested comment tree for a post
     */
    getCommentTree: (postId, maxDepth = 10) =>
      request(`/posts/${postId}/comments/tree?maxDepth=${maxDepth}`),

    /**
     * Create a comment on a post or reply to a comment
     * With our unified model, comments are just posts with a parent_id
     */
    createComment: (parentId, content) =>
      request(`/posts`, {
        method: 'POST',
        body: {
          content,
          parent_id: parentId
        }
      }),

    /**
     * Update a post or comment
     */
    updateComment: (commentId, content) =>
      request(`/posts/${commentId}`, { method: 'PATCH', body: { content } }),

    /**
     * Delete a post or comment
     */
    deleteComment: (commentId) =>
      request(`/posts/${commentId}`, { method: 'DELETE' }),

    likePost: (postId) =>
      request(`/posts/${postId}/like`, { method: 'POST' }),

    unlikePost: (postId) =>
      request(`/posts/${postId}/like`, { method: 'DELETE' }),

    getLikeStatus: (postId) =>
      request(`/posts/${postId}/like/status`, { method: 'GET' }),

    getLikesCount: (postId) =>
      request(`/posts/${postId}/likes`, { method: 'GET' })
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
    download: (attachmentId) =>
      requestBlob(`/attachments/${attachmentId}`)
  },

  // Events endpoints
  events: {
    getAll: (search = '') => {
      const url = search ? `/events?search=${encodeURIComponent(search)}` : '/events';
      return request(url);
    },

    create: (eventData) =>
      request('/events', { method: 'POST', body: eventData }),

    resolve: (eventId, outcome) =>
      request(`/events/${eventId}`, { method: 'PATCH', body: { outcome } })
  },

  // Predictions endpoints
  predictions: {
    getAll: () =>
      request('/predictions'),

    getAssigned: () =>
      request('/predictions/assigned'),

    create: (event_id, prediction_value, confidence, prediction_type = 'binary', numerical_value = null, lower_bound = null, upper_bound = null, prob_vector = null) =>
      request('/predict', {
        method: 'POST',
        body: {
          event_id,
          prediction_value,
          confidence,
          prediction_type,
          numerical_value,
          lower_bound,
          upper_bound,
          prob_vector
        }
      }),

    resolve: (id, outcome) =>
      request(`/predictions/${id}`, { method: 'PATCH', body: { outcome } }),

    placeBet: (assignmentId, confidenceLevel, betOn) =>
      request(`/assignments/${assignmentId}/bet`, {
        method: 'POST',
        body: { confidenceLevel, betOn }
      }),

    getBettingStats: () =>
      request('/bets/stats')
  },

  // Scoring endpoints (via backend proxy to prediction engine)
  scoring: {
    // Get unified log scoring leaderboard
    getLeaderboard: (limit = 10) =>
      request(`/scoring/leaderboard?limit=${limit}`),

    // Get enhanced leaderboard with Brier scores
    getEnhancedLeaderboard: () =>
      request('/scoring/enhanced-leaderboard'),

    // Get user's reputation stats
    getUserReputation: (userId) =>
      request(`/scoring/user/${userId}/reputation`),

    // Update user's reputation points
    updateUserReputation: (userId) =>
      request(`/scoring/user/${userId}/update-reputation`, { method: 'POST' }),

    // Get user's enhanced accuracy with Brier scores
    getUserAccuracy: (userId) =>
      request(`/scoring/user/${userId}/accuracy`),

    // Get user's calibration data
    getUserCalibration: (userId) =>
      request(`/scoring/user/${userId}/calibration`),

    // Get user's Brier score
    getUserBrierScore: (userId) =>
      request(`/scoring/user/${userId}/brier`),

    // Admin functions to manually trigger score calculations
    calculateLogScores: () =>
      request('/scoring/calculate', { method: 'POST' }),

    calculateTimeWeights: () =>
      request('/scoring/time-weights', { method: 'POST' })
  },

  // Weekly assignment endpoints
  weekly: {
    getUserStatus: (userId) =>
      request(`/weekly/user/${userId}/status`)
  },

  // MLS / Core Crypto endpoints
  mls: {
    publishKeyPackages: (body) =>
      mlsRequest('/mls/key-packages', { method: 'POST', body }),
    sendCommitBundle: (body) =>
      mlsRequest('/mls/commit', { method: 'POST', body }),
    sendMessage: (body) =>
      mlsRequest('/mls/message', { method: 'POST', body }),
    sendHistorySecret: (body) =>
      mlsRequest('/mls/history-secret', { method: 'POST', body }),
    migrateConversation: (body) =>
      mlsRequest('/mls/migrate', { method: 'POST', body }),
    getKeyPackages: (userId, { ciphersuite, limit } = {}) => {
      const search = new URLSearchParams();
      if (ciphersuite != null) search.set('ciphersuite', String(ciphersuite));
      if (limit != null) search.set('limit', String(limit));
      const suffix = search.size ? `?${search.toString()}` : '';
      return mlsRequest(`/mls/key-packages/${userId}${suffix}`);
    },
    createCredentialRequest: (body) =>
      mlsRequest('/mls/credentials/request', { method: 'POST', body }),
    completeCredential: (body) =>
      mlsRequest('/mls/credentials/complete', { method: 'POST', body }),
    listCredentials: (status) => {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
      return mlsRequest(`/mls/credentials${suffix}`);
    },
    upsertConversation: (body) =>
      mlsRequest('/mls/conversations', { method: 'POST', body }),
    updateGroupInfo: (conversationId, body) =>
      mlsRequest(`/mls/conversations/${conversationId}/group-info`, { method: 'PUT', body }),
    setHistorySharing: (conversationId, body) =>
      mlsRequest(`/mls/conversations/${conversationId}/history-sharing`, { method: 'PUT', body }),
    getConversation: (conversationId) =>
      mlsRequest(`/mls/conversations/${conversationId}`),
    getMessages: (conversationId, { limit, before } = {}) => {
      const search = new URLSearchParams();
      if (limit != null) search.set('limit', String(limit));
      if (before) search.set('before', before);
      const suffix = search.size ? `?${search.toString()}` : '';
      return mlsRequest(`/mls/messages/${conversationId}${suffix}`);
    },
    // Direct Messages (DM)
    getDirectMessages: () =>
      mlsRequest('/mls/direct-messages'),
    createDirectMessage: (targetUserId) =>
      mlsRequest(`/mls/direct-messages/${targetUserId}`, { method: 'POST' }),
    getPendingMessages: () =>
      mlsRequest('/mls/queue/pending'),
    ackMessages: (messageIds) =>
      mlsRequest('/mls/queue/ack', { method: 'POST', body: { messageIds } })
    ,
    syncGroupMembers: (groupId, memberIds) =>
      mlsRequest(`/mls/groups/${encodeURIComponent(groupId)}/members/sync`, { method: 'POST', body: { memberIds } })
  },

  // Leaderboard endpoints (direct database queries for performance)
  leaderboard: {
    getGlobal: (limit = 10) =>
      request(`/leaderboard/global?limit=${limit}`),

    getFollowers: (limit = 10) =>
      request(`/leaderboard/followers?limit=${limit}`),

    getFollowing: (limit = 10) =>
      request(`/leaderboard/following?limit=${limit}`),

    getNetwork: (limit = 10) =>
      request(`/leaderboard/network?limit=${limit}`),

    getUserRank: () =>
      request('/leaderboard/rank')
  },

  // Notification endpoints
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

    getUnreadCount: () =>
      request('/notifications/count'),

    markAsRead: (notificationId) =>
      request(`/notifications/${notificationId}/read`, { method: 'PUT' }),

    markAllAsRead: () =>
      request('/notifications/mark-all-read', { method: 'PUT' }),

    delete: (notificationId) =>
      request(`/notifications/${notificationId}`, { method: 'DELETE' })
  },

  // Push notification endpoints
  push: {
    getVapidKey: () =>
      request('/push/vapid-public-key'),

    subscribe: (subscription) =>
      request('/push/subscribe', { method: 'POST', body: subscription }),

    unsubscribe: (endpoint) =>
      request('/push/subscribe', { method: 'DELETE', body: { endpoint } }),

    getPreferences: () =>
      request('/push/preferences'),

    updatePreferences: (preferences) =>
      request('/push/preferences', { method: 'PUT', body: preferences })
  },

  // Key management endpoints (for end-to-end encryption)
  keys: {
    storePublicKey: (publicKey) =>
      request('/keys', { method: 'POST', body: { publicKey } }),

    getMyPublicKey: () =>
      request('/keys/me'),

    getUserPublicKey: (userId) =>
      request(`/keys/user/${userId}`),

    getMultiplePublicKeys: (userIds) =>
      request('/keys/batch', { method: 'POST', body: { userIds } }),

    getUsersWithKeys: (limit = 50, offset = 0) =>
      request(`/keys/users?limit=${limit}&offset=${offset}`),

    verifyFingerprint: (userId, fingerprint) =>
      request('/keys/verify', { method: 'POST', body: { userId, fingerprint } }),

    deleteMyPublicKey: () =>
      request('/keys/me', { method: 'DELETE' }),

    getStats: () =>
      request('/keys/stats')
  },

  // Messaging endpoints (end-to-end encrypted)
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
      request(`/messages/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: messageData
      }),

    markAsRead: (messageIds) =>
      request('/messages/read', { method: 'POST', body: { messageIds } }),

    getUnreadCount: () =>
      request('/messages/unread-count'),

    deleteMessage: (messageId) =>
      request(`/messages/${messageId}`, { method: 'DELETE' })
  },

   // WebAuthn endpoints
  webauthn: {
    registerStart: () => request('/webauthn/register/options', { method: 'POST' }),
    registerFinish: (attestationResponse) => request('/webauthn/register/verify', { method: 'POST', body: attestationResponse }),
    authStart: (body) => request('/webauthn/login/options', { method: 'POST', body }),
    authFinish: (assertionResponse) => request('/webauthn/login/verify', { method: 'POST', body: assertionResponse }),
    credentials: () => request('/webauthn/credentials'),
    deleteCredential: (id) => request(`/webauthn/credentials/${id}`, { method: 'DELETE' })
  },

  // Verification endpoints (tiered identity verification)
  verification: {
    getStatus: () => request('/verification/status'),
    sendEmailVerification: () => request('/auth/verify-email/send', { method: 'POST' }),
    confirmEmailVerification: (token) => request('/auth/verify-email/confirm', { method: 'POST', body: { token } }),
    resendEmailVerification: () => request('/verification/email/resend', { method: 'POST' }),
    startPhoneVerification: (phoneNumber) => request('/verification/phone/start', { method: 'POST', body: { phoneNumber } }),
    confirmPhoneVerification: (phoneNumber, code) => request('/verification/phone/confirm', { method: 'POST', body: { phoneNumber, code } }),
    createPaymentSetup: () => request('/verification/payment/setup', { method: 'POST' })
  },

  // Admin moderation endpoints
  admin: {
    getAiFlags: (params = {}) => {
      const search = new URLSearchParams(params);
      const query = search.toString();
      return request(`/admin/ai-flags${query ? `?${query}` : ''}`);
    }
  },

  // Device management
  devices: {
    list: () => request('/devices'),
    register: (device_public_id, name) => request('/devices/register', { method: 'POST', body: { device_public_id, name } }),
    revoke: (id) => request(`/devices/${id}`, { method: 'DELETE' }),
    startLinking: (device_public_id, name) => request('/devices/link/start', { method: 'POST', body: { device_public_id, name } }),
    approveLinking: (token, approving_device_id) => request('/devices/link/approve', { method: 'POST', body: { token, approving_device_id } }),
    getLinkingStatus: (token) => request(`/devices/link/status?token=${token}`)
  }
};

export default api;
