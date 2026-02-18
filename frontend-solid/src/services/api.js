const DEFAULT_API_BASE = 'http://127.0.0.1:3005/api';
const DEFAULT_LIMIT = 20;

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

const getStoredToken = () => {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
};

const request = async (endpoint, options = {}) => {
  const token = getStoredToken();
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

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${resolveApiBase()}${endpoint}`, config);
  if (!response.ok) {
    const body = await response.text();
    const message = body?.trim() || `Request failed: ${response.status}`;
    throw new Error(message || `Request failed: ${response.status}`);
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

const requestBlob = async (endpoint, options = {}) => {
  const token = getStoredToken();
  const headers = {
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${resolveApiBase()}${endpoint}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.text();
    const message = body?.trim() || `Request failed: ${response.status}`;
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.blob();
};

const requestForm = async (endpoint, body, options = {}) => {
  const token = getStoredToken();
  const headers = {
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${resolveApiBase()}${endpoint}`, {
    ...options,
    headers,
    body
  });
  if (!response.ok) {
    const bodyText = await response.text();
    const message = bodyText?.trim() || `Request failed: ${response.status}`;
    throw new Error(message || `Request failed: ${response.status}`);
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

export const authLogin = (email, password) => request('/login', {
  method: 'POST',
  body: { email, password }
});

export const registerUser = (username, email, password) => request('/users/register', {
  method: 'POST',
  body: { username, email, password }
});

export const forgotPassword = (email) => request('/auth/forgot-password', {
  method: 'POST',
  body: { email }
});

export const resetPassword = (token, newPassword, acknowledged, devicePublicId) => {
  const body = { token, newPassword, acknowledged };
  if (devicePublicId) {
    body.device_public_id = devicePublicId;
  }
  return request('/auth/reset-password', {
    method: 'POST',
    body
  });
};

export const getCurrentUser = () => request('/me');

const clampLimit = (limit = DEFAULT_LIMIT) => {
  return String(Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 50));
};

const buildPostParams = ({ cursor = null, limit = DEFAULT_LIMIT } = {}) => {
  const params = new URLSearchParams();
  params.set('limit', clampLimit(limit));
  if (cursor) {
    params.set('cursor', cursor);
  }
  return params.toString();
};

export const getPostsPage = ({ cursor = null, limit = DEFAULT_LIMIT } = {}) => {
  const query = buildPostParams({ cursor, limit });
  return request(`/posts?${query}`);
};

export const getFeedPage = ({ cursor = null, limit = DEFAULT_LIMIT } = {}) => {
  const query = buildPostParams({ cursor, limit });
  return request(`/feed?${query}`);
};

export const createPost = (content, image_attachment_id = null, image_url = null) => {
  return request('/posts', {
    method: 'POST',
    body: {
      content,
      image_attachment_id,
      image_url
    }
  });
};

export const uploadPostImage = (file) => {
  const form = new FormData();
  form.append('file', file);
  return requestForm('/attachments/post', form, { method: 'POST' });
};

export const getPostComments = (postId) =>
  request(`/posts/${postId}/comments`);

export const createComment = (postId, content) =>
  request('/posts', {
    method: 'POST',
    body: {
      parent_id: postId,
      content
    }
  });

export const updatePost = (postId, updates) =>
  request(`/posts/${postId}`, {
    method: 'PATCH',
    body: updates
  });

export const deletePost = (postId) =>
  request(`/posts/${postId}`, {
    method: 'DELETE'
  });

export const likePost = (postId) =>
  request(`/posts/${postId}/like`, {
    method: 'POST'
  });

export const unlikePost = (postId) =>
  request(`/posts/${postId}/like`, {
    method: 'DELETE'
  });

export const getLikeStatus = (postId) =>
  request(`/posts/${postId}/like/status`, {
    method: 'GET'
  });

export const getAttachmentUrl = (attachmentId) => {
  const token = getStoredToken();
  const baseUrl = `${resolveApiBase()}/attachments/${attachmentId}`;
  if (!token) {
    return baseUrl;
  }
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
};

export const getHealth = () => request('/health');

export const getPosts = (limit = DEFAULT_LIMIT) => {
  const query = new URLSearchParams();
  query.set('limit', clampLimit(limit));
  return request(`/posts?${query.toString()}`);
};

export const getEvents = (search = null) => {
  const query = new URLSearchParams();
  if (search && search.trim()) {
    query.set('search', search.trim());
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request(`/events${suffix}`);
};

export const createEvent = (title, details, closingDate) => {
  return request('/events', {
    method: 'POST',
    body: {
      title,
      details,
      closing_date: closingDate
    }
  });
};

export const getPredictions = () =>
  request('/predictions');

export const createPrediction = (eventId, predictionValue, confidence, predictionType = 'binary') => {
  return request('/predict', {
    method: 'POST',
    body: {
      event_id: eventId,
      prediction_value: predictionValue,
      confidence: Number(confidence),
      prediction_type: predictionType
    }
  });
};

export const getScoringLeaderboard = (limit = 10) => {
  const query = new URLSearchParams();
  query.set('limit', String(limit));
  return request(`/scoring/leaderboard?${query.toString()}`);
};

export const getPredictionLeaderboardFallback = () =>
  request('/leaderboard/global?limit=10');

export const getPostsPayloadItems = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.posts)) return payload.posts;
  return [];
};

export const getPostsPaging = (payload) => ({
  items: getPostsPayloadItems(payload),
  hasMore: Boolean(payload?.hasMore),
  nextCursor: payload?.nextCursor || null
});

export const getPostById = (postId) =>
  request(`/posts/${postId}`);

export const getUser = (id) =>
  request(`/users/${id}`);

export const updateProfile = ({ username, bio }) => {
  const body = {};
  if (typeof username !== 'undefined') {
    body.username = username;
  }
  if (typeof bio !== 'undefined') {
    body.bio = bio;
  }
  return request('/users/profile', {
    method: 'PATCH',
    body
  });
};

export const followUser = (id) =>
  request(`/users/${id}/follow`, { method: 'POST' });

export const unfollowUser = (id) =>
  request(`/users/${id}/follow`, { method: 'DELETE' });

export const getFollowingStatus = (id) =>
  request(`/users/${id}/following-status`);

export const getFollowers = (id) =>
  request(`/users/${id}/followers`);

export const getFollowing = (id) =>
  request(`/users/${id}/following`);

export const getUserReputation = (userId) =>
  request(`/scoring/user/${userId}/reputation`);

export const getUiPreferences = () =>
  request('/users/me/preferences');

export const updateUiPreferences = (skin) =>
  request('/users/me/preferences', {
    method: 'PUT',
    body: { skin }
  });

export const getNotifications = ({ limit = DEFAULT_LIMIT, offset = 0, unreadOnly = false } = {}) => {
  const params = new URLSearchParams({
    limit: String(clampLimit(limit)),
    offset: String(Math.max(0, Number(offset) || 0)),
    unreadOnly: unreadOnly ? 'true' : 'false'
  });
  return request(`/notifications?${params.toString()}`);
};

export const getUnreadNotificationCount = () =>
  request('/notifications/count');

export const markNotificationRead = (notificationId) =>
  request(`/notifications/${notificationId}/read`, { method: 'PUT' });

export const markAllNotificationsRead = () =>
  request('/notifications/mark-all-read', { method: 'PUT' });

export const deleteNotification = (notificationId) =>
  request(`/notifications/${notificationId}`, { method: 'DELETE' });

export const getDirectMessages = () =>
  request('/mls/direct-messages');

export const createDirectMessage = (targetUserId) =>
  request(`/mls/direct-messages/${targetUserId}`, { method: 'POST' });

export const getGroupMessages = (groupId, afterId = null) => {
  const params = new URLSearchParams();
  if (afterId) {
    params.set('afterId', String(afterId));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return request(`/mls/messages/group/${groupId}${suffix}`);
};

export { requestBlob };
