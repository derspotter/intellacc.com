const jwt = require("jsonwebtoken");

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  console.log('authenticateJWT called for route:', req.path);

  if (authHeader) {
    const token = authHeader.split(" ")[1];

    console.log('Token:', token);

    jwt.verify(token, "your_jwt_secret", (err, user) => {
      if (err) {
        console.error('JWT verification error:', err);
        
        // Provide more specific error messages
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({ 
            message: "Authentication token has expired", 
            error: "token_expired",
            expiredAt: err.expiredAt
          });
        }
        
        return res.status(403).json({ 
          message: "Authentication failed: Invalid token",
          error: err.name
        });
      }
      
      // Fix the user object structure: standardize to use 'id' instead of 'userId'
      const standardizedUser = {
        ...user,
        id: user.userId // Map userId to id for consistency
      };
      
      req.user = standardizedUser; // Attach standardized user data to request
      next();
    });
  } else {
    console.log('No token provided');
    res.status(401).json({ message: "Unauthorized: No token provided" });
  }
};

module.exports = authenticateJWT;
