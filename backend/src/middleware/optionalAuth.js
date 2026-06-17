// backend/src/middleware/optionalAuth.js
// Attaches req.user when a valid JWT is present, but never rejects the request
// when the token is missing or invalid. Used on public-readable endpoints that
// still want to personalize the response for logged-in viewers.
const { verifyToken, getUserFromToken } = require('../utils/jwt');

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();

  const token = authHeader.split(' ')[1];
  if (!token) return next();

  const decoded = verifyToken(token);
  if (decoded && !decoded.error) {
    req.user = getUserFromToken(decoded);
  }
  return next();
};

module.exports = optionalAuth;
