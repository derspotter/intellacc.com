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
        return res.status(403).json({ message: "Forbidden: Invalid token" });
      }
      req.user = user; // Attach user data to request
      next();
    });
  } else {
    console.log('No token provided');
    res.status(401).json({ message: "Unauthorized: No token provided" });
  }
};

module.exports = authenticateJWT;
