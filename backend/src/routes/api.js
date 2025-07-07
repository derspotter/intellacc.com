// backend/src/routes/api.js

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const postController = require('../controllers/postController');
const likeController = require('../controllers/likeController');
const predictionsController = require('../controllers/predictionsController');
const scoringController = require('../controllers/scoringController');
const leaderboardController = require('../controllers/leaderboardController');
const authenticateJWT = require("../middleware/auth");

// Base test route
router.get("/", (req, res) => {
});

// Health check route
router.get("/health-check", (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

// User Routes
router.post("/users", userController.createUser);
router.post("/users/register", userController.createUser); // Alias for registration
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
router.get("/events", predictionsController.getEvents); // Temporarily no auth for testing
router.get("/categories", predictionsController.getCategories); // Get available categories
router.patch("/predictions/:id", authenticateJWT, predictionsController.resolvePrediction);
router.get("/predictions", authenticateJWT, predictionsController.getUserPredictions);

// ADMIN: Delete all predictions (for testing only)
router.delete("/predictions/all", authenticateJWT, predictionsController.deleteAllPredictions);

// Assigned Predictions & Betting System
router.post("/predictions/assign", authenticateJWT, predictionsController.assignPredictions);
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

// Comment Routes (using unified posts/comments model)
router.get("/posts/:id/comments", authenticateJWT, postController.getComments);         // Get direct comments for a post
router.get("/posts/:id/comments/tree", authenticateJWT, postController.getCommentTree); // Get nested comment tree

// Note: Creating comments now uses the same endpoint as creating posts
// Just include parent_id in the request body to create a comment/reply

// Like Routes
router.post("/posts/:postId/like", authenticateJWT, likeController.likePost);
router.delete("/posts/:postId/like", authenticateJWT, likeController.unlikePost);
router.get("/posts/:postId/like/status", authenticateJWT, likeController.checkLikeStatus);
router.get("/posts/:postId/likes", authenticateJWT, likeController.getLikesCount);

// Scoring Routes (proxy to prediction engine)
router.get("/scoring/leaderboard", scoringController.getLogScoringLeaderboard);
router.get("/scoring/enhanced-leaderboard", scoringController.getEnhancedLeaderboard);
router.get("/scoring/user/:userId/reputation", authenticateJWT, scoringController.getUserReputation);
router.post("/scoring/user/:userId/update-reputation", authenticateJWT, scoringController.updateUserReputation);
router.get("/scoring/user/:userId/accuracy", authenticateJWT, scoringController.getUserEnhancedAccuracy);

// Leaderboard Routes (direct database queries for performance)
router.get("/leaderboard/fast", leaderboardController.getFastLeaderboard); // Fast leaderboard from stored rankings
router.get("/leaderboard/global", leaderboardController.getGlobalLeaderboard);
router.get("/leaderboard/followers", authenticateJWT, leaderboardController.getFollowersLeaderboard);
router.get("/leaderboard/following", authenticateJWT, leaderboardController.getFollowingLeaderboard);
router.get("/leaderboard/network", authenticateJWT, leaderboardController.getNetworkLeaderboard);
router.get("/leaderboard/rank", authenticateJWT, leaderboardController.getUserRank);
router.get("/scoring/user/:userId/calibration", authenticateJWT, scoringController.getUserCalibration);
router.get("/scoring/user/:userId/brier", authenticateJWT, scoringController.getUserBrierScore);
router.post("/scoring/calculate", authenticateJWT, scoringController.calculateLogScores);
router.post("/scoring/time-weights", authenticateJWT, scoringController.calculateTimeWeights);

module.exports = router;
