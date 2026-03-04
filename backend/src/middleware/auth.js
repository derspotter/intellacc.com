// backend/src/middleware/auth.js
const db = require('../db');
const { verifyToken, getUserFromToken } = require('../utils/jwt');
const crypto = require('crypto');

let supportsDeletedAt = null;

const loadAuthUserRow = async (userId) => {
  if (supportsDeletedAt === false) {
    const res = await db.query('SELECT password_changed_at FROM users WHERE id = $1', [userId]);
    return res.rows[0];
  }

  try {
    const res = await db.query('SELECT password_changed_at, deleted_at FROM users WHERE id = $1', [userId]);
    supportsDeletedAt = true;
    return res.rows[0];
  } catch (err) {
    if (err.code === '42703') {
      supportsDeletedAt = false;
      const res = await db.query('SELECT password_changed_at FROM users WHERE id = $1', [userId]);
      return res.rows[0];
    }
    throw err;
  }
};

const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  console.log('authenticateJWT called for route:', req.path);

  if (!authHeader) {
    console.log('No token provided');
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];
  // Do not log tokens

  // API Key Authentication Path
  if (token && token.startsWith('sk_live_')) {
    try {
      const hashedKey = crypto.createHash('sha256').update(token).digest('hex');
      const result = await db.query(
        'SELECT u.id, u.role, u.password_changed_at, u.deleted_at, a.scopes, a.is_bot FROM users u JOIN api_keys a ON u.id = a.user_id WHERE a.key_hash = $1',
        [hashedKey]
      );
      
      if (result.rows.length === 0) {
        return res.status(403).json({ message: "Authentication failed: Invalid API key" });
      }
      
      const userRow = result.rows[0];
      if (userRow.deleted_at) {
        return res.status(403).json({ message: 'Account has been deleted' });
      }
      
      // Update last_used_at for the API key in the background
      db.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_hash = $1', [hashedKey]).catch(err => console.error('Failed to update API key last_used_at:', err));

      req.user = {
        id: userRow.id,
        userId: userRow.id,
        role: userRow.role || 'user',
        isAgent: true,
        isBot: userRow.is_bot || false,
        scopes: userRow.scopes || []
      };
      
      return next();
    } catch (err) {
      console.error('API key auth error:', err);
      return res.status(500).json({ message: 'Authentication failed: Server error' });
    }
  }
  
  // JWT Authentication Path
  const decoded = verifyToken(token);
  
  if (decoded.error) {
    console.error('JWT verification error:', decoded.error);
    
    // Provide more specific error messages
    if (decoded.error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: "Authentication token has expired", 
        error: "token_expired",
        expiredAt: decoded.error.expiredAt
      });
    }
    
    return res.status(403).json({ 
      message: "Authentication failed: Invalid token",
      error: decoded.error.name
    });
  }
  
  try {
    const userId = decoded.userId;
    const userRow = await loadAuthUserRow(userId);
    if (!userRow) {
      return res.status(401).json({ message: 'Authentication failed: User not found' });
    }

    if (userRow.deleted_at) {
      return res.status(403).json({ message: 'Account has been deleted' });
    }

    const passwordChangedAt = userRow.password_changed_at;
    if (passwordChangedAt && decoded.iat) {
      const tokenIssuedAt = new Date(decoded.iat * 1000);
      if (tokenIssuedAt < new Date(passwordChangedAt)) {
        return res.status(401).json({
          message: 'Authentication token has been revoked',
          error: 'token_revoked'
        });
      }
    }
  } catch (err) {
    console.error('JWT user lookup error:', err);
    return res.status(500).json({ message: 'Authentication failed: Server error' });
  }

  // Attach standardized user data to request
  req.user = getUserFromToken(decoded);
  next();
};

module.exports = authenticateJWT;

// Admin-only guard
module.exports.requireAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role === 'admin') {
      return next();
    }

    return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    console.error('Admin auth error:', err);
    return res.status(500).json({ error: 'Failed to verify admin access' });
  }
};
