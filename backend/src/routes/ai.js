// Personal BYOK AI assistant routes. Mounted at /api/ai behind authenticateJWT
// and rejectAgentKeys (see routes/api.js): settings, inference and private
// history are session-only surfaces.
const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/aiAssistantController');

const router = express.Router();
const isProdEnv = process.env.NODE_ENV === 'production';
const perUser = (prefix) => (req) => `${prefix}:${req.user?.id || req.ip}`;

// Route limiter on top of the durable per-user budget (aiBudgetService):
// this one stops bursts before they touch the database at all.
const generationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: isProdEnv ? 20 : 1000,
  keyGenerator: perUser('ai-generate'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many AI requests, slow down' }
});
const settingsRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProdEnv ? 30 : 1000,
  keyGenerator: perUser('ai-settings'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many AI settings changes, try again later' }
});

router.get('/settings', controller.getSettings);
router.put('/settings', settingsRateLimit, controller.saveSettings);
router.delete('/settings', settingsRateLimit, controller.deleteSettings);
router.post('/test', generationRateLimit, controller.testSettings);

router.get('/conversations', controller.listConversations);
router.post('/conversations', settingsRateLimit, controller.createConversation);
router.get('/conversations/:id', controller.getConversation);
router.delete('/conversations/:id', controller.deleteConversation);
router.post('/conversations/:id/messages', generationRateLimit, controller.sendMessage);

router.get('/public-replies/:postId', controller.getPublicReplyStatus);

module.exports = router;
