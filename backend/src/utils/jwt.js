// backend/src/utils/jwt.js
const jwt = require('jsonwebtoken');

// Get secret from environment variable
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
// 30d: sessions on a social app must survive phone tab suspends; tokens
// issued before a password change are revoked via password_changed_at.
const JWT_EXPIRY = process.env.JWT_EXPIRY || '30d';

/**
 * JWT utility functions for token operations
 */
module.exports = {
  /**
   * Generate a new JWT token
   * @param {Object} payload - Data to encode in the token
   * @returns {string} JWT token
   */
  generateToken: (payload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  },

  /**
   * Verify and decode a JWT token
   * @param {string} token - JWT token to verify
   * @returns {Object} Decoded payload or error object
   */
  verifyToken: (token) => {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return { error: err };
    }
  },

  /**
   * Extract user data from a decoded token and standardize it
   * @param {Object} tokenData - Decoded JWT token
   * @returns {Object} Standardized user object or null if invalid
   */
  getUserFromToken: (tokenData) => {
    if (!tokenData || tokenData.error) return null;
    
    return {
      id: tokenData.userId,
      userId: tokenData.userId, // For backward compatibility
      role: tokenData.role || 'user'
    };
  }
};