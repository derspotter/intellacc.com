// backend/src/middleware/auth.js
const { verifyToken, getUserFromToken } = require('../utils/jwt');

const authenticateJWT = (req, res, next) => {
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
  
  // Attach standardized user data to request
  req.user = getUserFromToken(decoded);
  next();
};

module.exports = authenticateJWT;