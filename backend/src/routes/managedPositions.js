const express = require('express');
const authenticateJWT = require('../middleware/auth');
const { requirePhoneVerified } = require('../middleware/verification');
const { requireScope } = require('../middleware/scopes');

const router = express.Router({ mergeParams: true });
router.use(authenticateJWT);
router.use((req, res, next) => {
  const id = Number(req.params.eventId);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) {
    return res.status(400).json({ error: 'Invalid event id' });
  }
  next();
});

const proxy = async (req, res, body) => {
  const base = process.env.PREDICTION_ENGINE_BASE_URL || 'http://prediction-engine:3001';
  const token = process.env.PREDICTION_ENGINE_AUTH_TOKEN;
  const path = `${base}/events/${Number(req.params.eventId)}/managed-position`;
  try {
    const response = await fetch(body ? path : `${path}?user_id=${req.user.id}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-engine-token': token } : {})
      },
      ...(body ? { body: JSON.stringify({ ...body, user_id: req.user.id }) } : {}),
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Managed position proxy failed:', error.name);
    return res.status(502).json({ error: 'Position manager is unavailable. Please try again.' });
  }
};

router.get('/', (req, res) => proxy(req, res));
router.post('/', requireScope('market:trade'), (req, res, next) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }
  // Pausing must remain possible after verification or the market expires.
  if (!req.body.enabled) return next();
  const { belief_prob, kelly_fraction } = req.body;
  if (typeof belief_prob !== 'number' || !Number.isFinite(belief_prob)
      || belief_prob <= 0 || belief_prob >= 1) {
    return res.status(400).json({ error: 'Probability must be between 0 and 1, exclusive' });
  }
  if (![0.25, 0.5, 1].includes(kelly_fraction)) {
    return res.status(400).json({ error: 'Choose quarter, half, or full Kelly' });
  }
  return requirePhoneVerified(req, res, next);
}, (req, res) => proxy(req, res, req.body.enabled ? {
  enabled: true,
  belief_prob: req.body.belief_prob,
  kelly_fraction: req.body.kelly_fraction
} : { enabled: false }));

module.exports = router;
