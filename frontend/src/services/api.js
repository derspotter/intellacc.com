// src/services/api.js
import { getToken, clearToken } from './auth';

// Base API URL
const API_BASE = '/api';

/**
 * Custom API error class
 */
class ApiError extends Error {
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

/**
 * API client methods
 */
export const api = {
  // Auth endpoints
  auth: {
    login: (email, password) => 
      request('/login', { method: 'POST', body: { email, password } }),
      
    register: (username, email, password) => 
      request('/users/register', { method: 'POST', body: { username, email, password } })
  },
  
  // Users endpoints
  users: {
    getProfile: () => 
      request('/me'),
      
    updateProfile: (bio) => 
      request('/users/profile', { method: 'PATCH', body: { bio } }),
      
    getUser: (id) => 
      request(`/users/${id}`),
      
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
      
    getById: (id) => 
      request(`/posts/${id}`),
      
    create: (content, image_url) => 
      request('/posts', { method: 'POST', body: { content, image_url } }),
      
    update: (id, content, image_url) => 
      request(`/posts/${id}`, { method: 'PATCH', body: { content, image_url } }),
      
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
      
    create: (event_id, prediction_value, confidence) => 
      request('/predict', { 
        method: 'POST', 
        body: { event_id, prediction_value, confidence } 
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
  }
};

export default api;