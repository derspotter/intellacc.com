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
const marketQuestionController = require('../controllers/marketQuestionController');
const mlsRoutes = require('./mls');
const authenticateJWT = require("../middleware/auth");
const { requireAdmin } = require("../middleware/auth");
const rateLimit = require('express-rate-limit');
const attachmentsController = require('../controllers/attachmentsController');
const verificationController = require('../controllers/verificationController');
const passwordResetController = require('../controllers/passwordResetController');
const aiModerationController = require('../controllers/aiModerationController');
const federationController = require('../controllers/federationController');
const atprotoController = require('../controllers/atprotoController');
const socialAuthController = require('../controllers/socialAuthController');
const { requireTier, requireEmailVerified, requirePhoneVerified, requirePaymentVerified } = require('../middleware/verification');
const PREDICTION_ENGINE_AUTH_TOKEN = process.env.PREDICTION_ENGINE_AUTH_TOKEN;
const predictionEngineHeaders = {
    'Content-Type': 'application/json',
    ...(PREDICTION_ENGINE_AUTH_TOKEN ? { 'x-engine-token': PREDICTION_ENGINE_AUTH_TOKEN } : {})
};

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
router.get("/users/username/:username", authenticateJWT, userController.getUserByUsername);
router.get("/users/:id", authenticateJWT, userController.getUser);
router.post('/login', userController.loginUser);

// Social OAuth login routes
router.post('/auth/atproto/start', socialAuthController.startAtprotoLogin);
router.get('/auth/atproto/callback', socialAuthController.finishAtprotoLogin);
router.post('/auth/mastodon/start', socialAuthController.startMastodonLogin);
router.get('/auth/mastodon/callback', socialAuthController.finishMastodonLogin);

// Email Verification Routes (Tier 1)
// Confirm can be unauthenticated (token contains user info) for email links
const emailResendRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 3, // 3 resends per 15 minutes
    message: { error: 'Too many verification emails requested, please try again later' },
});
router.post('/auth/verify-email/send', authenticateJWT, emailResendRateLimit, verificationController.sendVerificationEmail);
router.post('/auth/verify-email/confirm', verificationController.confirmEmailVerification);
router.get('/verification/status', authenticateJWT, verificationController.getVerificationStatus);
router.post('/verification/email/resend', authenticateJWT, emailResendRateLimit, verificationController.resendVerificationEmail);

// Phone Verification Routes (Tier 2)
const normalizePhoneForLimit = (phoneNumber) => (phoneNumber || '').replace(/\D/g, '');
const phoneIpRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: { error: 'Too many verification attempts from this IP. Try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
const phoneUserRateLimit = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 5,
    keyGenerator: (req) => String(req.user?.id || req.ip),
    message: { error: 'Too many verification attempts for this account. Try again tomorrow.' },
    standardHeaders: true,
    legacyHeaders: false
});
const phoneNumberRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    keyGenerator: (req) => normalizePhoneForLimit(req.body?.phoneNumber) || req.ip,
    message: { error: 'Too many verification attempts for this phone number. Try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
router.post(
    '/verification/phone/start',
    authenticateJWT,
    phoneIpRateLimit,
    phoneUserRateLimit,
    phoneNumberRateLimit,
    verificationController.startPhoneVerification
);
router.post('/verification/phone/confirm', authenticateJWT, verificationController.confirmPhoneVerification);

// Payment Verification Routes (Tier 3)
router.post('/verification/payment/setup', authenticateJWT, verificationController.createPaymentSetup);
router.post('/webhooks/stripe', verificationController.handleStripeWebhook);

const isProduction = process.env.NODE_ENV === 'production';
const passwordResetRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProduction ? 5 : 50,
    message: { error: 'Too many reset attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});
const deviceController = require('../controllers/deviceController');

// Password reset routes
router.post('/auth/forgot-password', passwordResetRateLimit, passwordResetController.forgotPassword);
router.post('/auth/reset-password', passwordResetRateLimit, passwordResetController.resetPassword);
router.post('/auth/reset-password/cancel', authenticateJWT, passwordResetController.cancelReset);

router.post('/users/change-password', authenticateJWT, userController.changePassword);
router.get("/me", authenticateJWT, userController.getUserProfile);
router.delete("/me", authenticateJWT, userController.deleteAccount);
router.patch("/users/profile", authenticateJWT, userController.editUserProfile);

// Follow System Routes
router.post("/users/:id/follow", authenticateJWT, userController.followUser);
router.delete("/users/:id/follow", authenticateJWT, userController.unfollowUser);
router.get("/users/:id/following-status", authenticateJWT, userController.getFollowingStatus);
router.get("/users/:id/followers", authenticateJWT, userController.getFollowers);
router.get("/users/:id/following", authenticateJWT, userController.getFollowing);

// ActivityPub Federation Routes
router.post('/federation/activitypub/follow', authenticateJWT, federationController.followActivityPubActor);
router.get('/federation/activitypub/following', authenticateJWT, federationController.getActivityPubFollowing);

// AT Protocol Federation Routes
router.get('/federation/atproto/client-metadata.json', atprotoController.getClientMetadata);
router.get('/federation/atproto/oauth/callback', atprotoController.oauthCallback);
router.post('/federation/atproto/oauth/start', authenticateJWT, atprotoController.startOAuth);
router.get('/federation/atproto/account', authenticateJWT, atprotoController.getAccount);
router.delete('/federation/atproto/account', authenticateJWT, atprotoController.disconnectAccount);
router.post('/federation/atproto/posts/:postId/enqueue', authenticateJWT, atprotoController.enqueuePost);

// Portfolio Routes
router.get("/users/:id/positions", (req, res, next) => {
    console.log('🚀 ROUTE HIT: /users/:id/positions for userId:', req.params.id);
    next();
}, authenticateJWT, userController.getUserPositions);

// Prediction/Events Routes
router.post("/predict", authenticateJWT, requirePhoneVerified, predictionsController.createPrediction);
router.post("/events", authenticateJWT, requirePaymentVerified, predictionsController.createEvent);
router.get("/events", predictionsController.getEvents); // Temporarily no auth for testing
router.get("/categories", predictionsController.getCategories); // Get available categories
router.patch("/predictions/:id", authenticateJWT, predictionsController.resolvePrediction);
router.get("/predictions", authenticateJWT, predictionsController.getUserPredictions);

// Community market question submission + validation
router.get('/market-questions/config', authenticateJWT, marketQuestionController.getConfig);
router.post('/market-questions', authenticateJWT, marketQuestionController.createSubmission);
router.get('/market-questions', authenticateJWT, marketQuestionController.listSubmissions);
router.get('/market-questions/review-queue', authenticateJWT, marketQuestionController.getReviewQueue);
router.post('/market-questions/rewards/run', authenticateJWT, requireAdmin, marketQuestionController.runAutomaticRewards);
router.get('/market-questions/:id', authenticateJWT, marketQuestionController.getSubmission);
router.post('/market-questions/:id/reviews', authenticateJWT, marketQuestionController.submitReview);
router.post('/market-questions/:id/rewards/traction', authenticateJWT, requireAdmin, marketQuestionController.rewardTraction);
router.post('/market-questions/:id/rewards/resolution', authenticateJWT, requireAdmin, marketQuestionController.rewardResolution);

// ADMIN: Delete all predictions (for testing only)
router.delete("/predictions/all", authenticateJWT, predictionsController.deleteAllPredictions);

// Assigned Predictions & Betting System
router.post("/predictions/assign", authenticateJWT, predictionsController.assignPredictions);
router.get("/predictions/assigned", authenticateJWT, predictionsController.getAssignedPredictions);
router.post("/assignments/:id/bet", authenticateJWT, requirePhoneVerified, predictionsController.placeBet);
router.get("/bets/stats", authenticateJWT, predictionsController.getMonthlyBettingStats);

// Post Routes (require email verification - Tier 1)
router.post("/posts", authenticateJWT, requireEmailVerified, postController.createPost);
router.get("/posts", postController.getPosts);                                 // Get all posts (public)
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

// Admin AI moderation routes
router.get('/admin/ai-flags', authenticateJWT, aiModerationController.getFlaggedContent);

// Weekly Assignment Routes (admin-only for ops)
router.post("/weekly/assign", authenticateJWT, requireAdmin, weeklyAssignmentController.assignWeeklyPredictions);
router.post("/weekly/process-completed", authenticateJWT, requireAdmin, weeklyAssignmentController.processCompletedAssignments);
router.post("/weekly/apply-decay", authenticateJWT, requireAdmin, weeklyAssignmentController.applyWeeklyDecay);
router.post("/weekly/run-all", authenticateJWT, requireAdmin, weeklyAssignmentController.runWeeklyProcesses);
router.get("/weekly/stats", authenticateJWT, requireAdmin, weeklyAssignmentController.getWeeklyStats);
router.get("/weekly/user/:userId/status", authenticateJWT, weeklyAssignmentController.getUserWeeklyStatus);

// MLS Routes (Messaging Layer Security - E2EE)
router.use('/mls', mlsRoutes);

// Attachments (pre-signed URL scaffold)
router.post('/attachments/presign-upload', authenticateJWT, attachmentsController.presignUpload);
router.get('/attachments/presign-download', authenticateJWT, attachmentsController.presignDownload);
router.post('/attachments/post', authenticateJWT, requireEmailVerified, attachmentsController.uploadPostImage);
router.post('/attachments/message', authenticateJWT, attachmentsController.uploadMessageAttachment);
router.get('/attachments/:id', authenticateJWT, attachmentsController.downloadAttachment);

// LMSR Market API proxy routes (bypass CORS issues)
router.get("/events/:eventId/market", async (req, res) => {
    try {
        const { eventId } = req.params;
        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/market`, {
            headers: predictionEngineHeaders
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('Market proxy error:', error);
        res.status(500).json({ error: 'Failed to fetch market state' });
    }
});

router.get("/events/:eventId/trades", async (req, res) => {
    try {
        const { eventId } = req.params;
        const limit = req.query.limit || 20;
        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/trades?limit=${limit}`, {
            headers: predictionEngineHeaders
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('Trades proxy error:', error);
        res.status(500).json({ error: 'Failed to fetch recent trades' });
    }
});

router.get("/events/:eventId/shares", authenticateJWT, requirePhoneVerified, async (req, res) => {
    try {
        const { eventId } = req.params;
        const userId = req.user.id;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/shares?user_id=${userId}`, {
            headers: predictionEngineHeaders
        });
        const data = await response.json();

        res.json(data);
    } catch (error) {
        console.error('Shares proxy error:', error);
        res.status(500).json({ error: 'Failed to fetch user shares' });
    }
});

router.get("/events/:eventId/kelly", authenticateJWT, requirePhoneVerified, async (req, res) => {
    try {
        const { eventId } = req.params;
        const { belief } = req.query;
        const userId = req.user.id;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/kelly?belief=${belief}&user_id=${userId}`, {
            headers: predictionEngineHeaders
        });
        const data = await response.json();

        res.json(data);
    } catch (error) {
        console.error('Kelly proxy error:', error);
        res.status(500).json({ error: 'Failed to fetch Kelly suggestion' });
    }
});

router.post("/events/:eventId/sell", authenticateJWT, requirePhoneVerified, async (req, res) => {
    try {
        const { eventId } = req.params;
        const { share_type, amount } = req.body;
        const userId = req.user.id;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/sell`, {
            method: 'POST',
            headers: predictionEngineHeaders,
            body: JSON.stringify({ user_id: userId, share_type, amount })
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
                        user_id: userId,
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

router.post("/events/:eventId/update", authenticateJWT, requirePhoneVerified, async (req, res) => {
    try {
        const { eventId } = req.params;
        const { stake, target_prob } = req.body;
        const userId = req.user.id;

        const response = await fetch(`http://prediction-engine:3001/events/${eventId}/update`, {
            method: 'POST',
            headers: predictionEngineHeaders,
            body: JSON.stringify({ user_id: userId, stake, target_prob })
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
                    user_id: userId,
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
