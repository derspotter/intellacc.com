// backend/src/middleware/auth.js
const db = require('../db');
const { verifyToken, getUserFromToken } = require('../utils/jwt');

const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  console.log('authenticateJWT called for route:', req.path);

  if (!authHeader) {
    console.log('No token provided');
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];
  // Do not log tokens
  
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
    const result = await db.query('SELECT password_changed_at FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Authentication failed: User not found' });
    }

    const passwordChangedAt = result.rows[0].password_changed_at;
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
