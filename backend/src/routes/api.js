// backend/src/routes/api.js

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const postController = require('../controllers/postController');
const commentController = require('../controllers/commentController');
const predictionsController = require('../controllers/predictionsController');
const authenticateJWT = require("../middleware/auth");

// Base test route
router.get("/", (req, res) => {
    res.json({ message: "API is working!" });
});

// User Routes
router.post("/users", userController.createUser);
router.get("/users/:id", authenticateJWT, userController.getUser);
router.post('/login', userController.loginUser);
router.get("/me", authenticateJWT, userController.getUserProfile);
router.patch("/users/profile", authenticateJWT, userController.editUserProfile);

// Follow System Routes
router.post("/users/:id/follow", authenticateJWT, userController.followUser);
router.delete("/users/:id/follow", authenticateJWT, userController.unfollowUser);
router.get("/users/:id/followers", authenticateJWT, userController.getFollowers);
router.get("/users/:id/following", authenticateJWT, userController.getFollowing);

// Prediction/Events Routes
router.post("/predict", authenticateJWT, predictionsController.createPrediction);
router.post("/events", authenticateJWT, predictionsController.createEvent);
router.get("/events", authenticateJWT, predictionsController.getEvents);
router.patch("/predictions/:id", authenticateJWT, predictionsController.resolvePrediction);
router.get("/predictions", authenticateJWT, predictionsController.getUserPredictions);

// Assigned Predictions & Betting System
router.post("/predictions/assign", authenticateJWT, userController.assignPredictions); // Keep in userController
router.get("/predictions/assigned", authenticateJWT, predictionsController.getAssignedPredictions);
router.post("/assignments/:id/bet", authenticateJWT, predictionsController.placeBet);
router.get("/bets/stats", authenticateJWT, predictionsController.getMonthlyBettingStats);

// Post Routes
router.post("/posts", authenticateJWT, postController.createPost);
router.get("/posts", authenticateJWT, postController.getPosts);                // Get all posts
router.get("/feed", authenticateJWT, postController.getFeed);                  // Get personalized feed
router.get("/posts/:id", authenticateJWT, postController.getPostById);         // Get a single post
router.patch("/posts/:id", authenticateJWT, postController.updatePost);        // Update a post
router.delete("/posts/:id", authenticateJWT, postController.deletePost);       // Delete a post

// Comment Routes
router.post("/posts/:postId/comments", authenticateJWT, commentController.createComment);
router.get("/posts/:postId/comments", authenticateJWT, commentController.getComments);
router.patch("/posts/:postId/comments/:commentId", authenticateJWT, commentController.updateComment);
router.delete("/posts/:postId/comments/:commentId", authenticateJWT, commentController.deleteComment);

module.exports = router;
