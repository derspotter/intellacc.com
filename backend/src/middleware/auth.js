const jwt = require("jsonwebtoken");

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(" ")[1];

    jwt.verify(token, "your_jwt_secret", (err, user) => {
      if (err) {
        return res.status(403).json({ message: "Forbidden: Invalid token" });
      }
      req.user = user; // Attach user data to request
      next();
    });
  } else {
    res.status(401).json({ message: "Unauthorized: No token provided" });
  }
};

module.exports = authenticateJWT;
