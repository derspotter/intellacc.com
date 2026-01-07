// backend/src/routes/api.js

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const postController = require('../controllers/postController');
const likeController = require('../controllers/likeController');
const predictionsController = require('../controllers/predictionsController');
const scoringController = require('../controllers/scoringController');
const leaderboardController = require('../controllers/leaderboardController');
const notificationController = require('../controllers/notificationController');
const pushController = require('../controllers/pushController');
const weeklyAssignmentController = require('../controllers/weeklyAssignmentController');
const mlsRoutes = require('./mls');
const authenticateJWT = require("../middleware/auth");
const rateLimit = require('express-rate-limit');
const attachmentsController = require('../controllers/attachmentsController');

// Base test route
router.get("/", (req, res) => {
});

// Health check route
router.get("/health-check", (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

// WebAuthn routes (Auth logic handled inside to allow public login routes)
router.use('/webauthn', require('./webauthn'));

// Device management routes
router.use('/devices', require('./device'));

// User Routes
router.post("/users", userController.createUser);
router.post("/users/register", userController.createUser); // Alias for registration
router.get("/users/search", authenticateJWT, userController.searchUsers); // User search (before :id to avoid conflict)
router.get('/users/master-key', authenticateJWT, userController.getMasterKey);
router.post('/users/master-key', authenticateJWT, userController.setMasterKey);
router.get("/users/:id", authenticateJWT, userController.getUser);
router.get("/users/username/:username", authenticateJWT, userController.getUserByUsername);
router.post('/login', userController.loginUser);
router.post('/users/change-password', authenticateJWT, userController.changePassword);
router.get("/me", authenticateJWT, userController.getUserProfile);
router.patch("/users/profile", authenticateJWT, userController.editUserProfile);

// Follow System Routes
router.post("/users/:id/follow", authenticateJWT, userController.followUser);
router.delete("/users/:id/follow", authenticateJWT, userController.unfollowUser);
router.get("/users/:id/following-status", authenticateJWT, userController.getFollowingStatus);
router.get("/users/:id/followers", authenticateJWT, userController.getFollowers);
router.get("/users/:id/following", authenticateJWT, userController.getFollowing);

// Portfolio Routes
router.get("/users/:id/positions", (req, res, next) => {
    console.log('🚀 ROUTE HIT: /users/:id/positions for userId:', req.params.id);
    next();
}, authenticateJWT, userController.getUserPositions);

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

// Notification Routes
router.get("/notifications", authenticateJWT, notificationController.getNotifications);
router.get("/notifications/count", authenticateJWT, notificationController.getUnreadCount);
router.put("/notifications/:notificationId/read", authenticateJWT, notificationController.markAsRead);
router.put("/notifications/mark-all-read", authenticateJWT, notificationController.markAllAsRead);
router.delete("/notifications/:notificationId", authenticateJWT, notificationController.deleteNotification);

// Push Notification Routes
router.get("/push/vapid-public-key", pushController.getVapidPublicKey);
router.post("/push/subscribe", authenticateJWT, pushController.subscribe);
router.delete("/push/subscribe", authenticateJWT, pushController.unsubscribe);
router.get("/push/preferences", authenticateJWT, pushController.getPreferences);
router.put("/push/preferences", authenticateJWT, pushController.updatePreferences);

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

// Weekly Assignment Routes
router.post("/weekly/assign", weeklyAssignmentController.assignWeeklyPredictions);
router.post("/weekly/process-completed", weeklyAssignmentController.processCompletedAssignments);
router.post("/weekly/apply-decay", weeklyAssignmentController.applyWeeklyDecay);
router.post("/weekly/run-all", weeklyAssignmentController.runWeeklyProcesses);
router.get("/weekly/stats", weeklyAssignmentController.getWeeklyStats);
router.get("/weekly/user/:userId/status", authenticateJWT, weeklyAssignmentController.getUserWeeklyStatus);

// MLS Routes (Messaging Layer Security - E2EE)
router.use('/mls', mlsRoutes);

// Attachments (pre-signed URL scaffold)
router.post('/attachments/presign-upload', authenticateJWT, attachmentsController.presignUpload);
router.get('/attachments/presign-download', authenticateJWT, attachmentsController.presignDownload);

// LMSR Market API proxy routes (bypass CORS issues)
router.get("/events/:eventId/shares", async (req, res) => {
    try {
        const { eventId } = req.params;
        const { user_id } = req.query;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/shares?user_id=${user_id}`);
        const data = await response.json();

        res.json(data);
    } catch (error) {
        console.error('Shares proxy error:', error);
        res.status(500).json({ error: 'Failed to fetch user shares' });
    }
});

router.get("/events/:eventId/kelly", async (req, res) => {
    try {
        const { eventId } = req.params;
        const { belief, user_id } = req.query;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/kelly?belief=${belief}&user_id=${user_id}`);
        const data = await response.json();

        res.json(data);
    } catch (error) {
        console.error('Kelly proxy error:', error);
        res.status(500).json({ error: 'Failed to fetch Kelly suggestion' });
    }
});

router.post("/events/:eventId/sell", async (req, res) => {
    try {
        const { eventId } = req.params;
        const { user_id, share_type, amount } = req.body;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/sell`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ user_id, share_type, amount })
        });

        const data = await response.json();

        if (response.ok) {
            // Broadcast market update to all connected clients using new_prob from sell response
            if (data.success && data.new_prob !== undefined) {
                const io = req.app.get('io');
                if (io) {
                    io.to('predictions').emit('marketUpdate', {
                        eventId: parseInt(eventId),
                        market_prob: parseFloat(data.new_prob),
                        cumulative_stake: data.cumulative_stake,
                        action: 'sell',
                        user_id,
                        share_type,
                        amount,
                        timestamp: new Date().toISOString()
                    });
                    console.log('📡 Market update broadcast (sell):', eventId, 'new_prob:', data.new_prob);
                }
            }

            res.json(data);
        } else {
            res.status(response.status).json(data);
        }
    } catch (error) {
        console.error('Sell shares proxy error:', error);
        res.status(500).json({ error: 'Failed to sell shares' });
    }
});

router.post("/events/:eventId/update", async (req, res) => {
    try {
        const { eventId } = req.params;
        const { user_id, stake, target_prob } = req.body;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/update`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ user_id, stake, target_prob })
        });

        const data = await response.json();

        if (response.ok) {
            // Broadcast market update to all connected clients
            const io = req.app.get('io');
            if (io && data.new_prob !== undefined) {
                io.to('predictions').emit('marketUpdate', {
                    eventId: parseInt(eventId),
                    market_prob: parseFloat(data.new_prob),
                    cumulative_stake: data.cumulative_stake,
                    action: 'stake',
                    user_id,
                    stake,
                    target_prob,
                    timestamp: new Date().toISOString()
                });
                console.log('📡 Market update broadcast:', eventId, 'new_prob:', data.new_prob);
            }

            res.json(data);
        } else {
            res.status(response.status).json(data);
        }
    } catch (error) {
        console.error('Market update proxy error:', error);
        res.status(500).json({ error: 'Failed to update market' });
    }
});

module.exports = router;
