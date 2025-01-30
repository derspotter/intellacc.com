// backend/src/routes/api.js

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authenticateJWT = require("../middleware/auth");

// Add `/api` test route
router.get("/", (req, res) => {
    res.json({ message: "API is working!" });
});

// Example User Routes
router.post("/users", userController.createUser);  // ❌ DO NOT add `authenticateJWT` here
router.get("/users/:id", authenticateJWT, userController.getUser);  // Protect user lookup
router.post('/login', userController.loginUser);
router.get("/me", authenticateJWT, userController.getUserProfile); // Protected user profile route (requires authentication)
router.post("/predict", authenticateJWT, userController.makePrediction);
router.post("/events", authenticateJWT, userController.createEvent);



module.exports = router;
