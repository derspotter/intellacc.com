/**
 * Guards for API-key (agent) authentication.
 *
 * Agent keys act on behalf of a user for markets and social actions only.
 * Security-sensitive surfaces (key management, credentials, devices, E2EE,
 * account lifecycle, admin) must stay JWT-session-only.
 */
const rateLimit = require('express-rate-limit');

const rejectAgentKeys = (req, res, next) => {
  if (req.user?.isAgent) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'This endpoint is not available to agent API keys'
    });
  }
  next();
};

// Per-user budget for agent traffic; generous for polling agents but a hard
// stop for accidental retry loops. JWT sessions are unaffected.
const agentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `agent:${req.user?.id || req.ip}`,
  skip: (req) => !req.user?.isAgent,
  message: { error: 'Rate limit exceeded', message: 'Agent API rate limit: 120 requests per minute' }
});

// Replay protection for retried mutations: when an Idempotency-Key header is
// present, the first response is cached (in-memory, 15 min) and replayed for
// identical retries. Scoped per user + route. Survives agent retry loops;
// does not survive process restarts, which is acceptable for v1.
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 5000;
const idempotencyCache = new Map();

const pruneIdempotencyCache = () => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiresAt < now) idempotencyCache.delete(key);
  }
  while (idempotencyCache.size > IDEMPOTENCY_MAX_ENTRIES) {
    idempotencyCache.delete(idempotencyCache.keys().next().value);
  }
};

const idempotent = (req, res, next) => {
  const headerKey = req.get('Idempotency-Key');
  if (!headerKey || !req.user?.id) return next();

  pruneIdempotencyCache();
  const cacheKey = `${req.user.id}:${req.method}:${req.baseUrl}${req.path}:${headerKey}`;
  const cached = idempotencyCache.get(cacheKey);
  if (cached) {
    if (cached.pending) {
      return res.status(409).json({ error: 'Request with this Idempotency-Key is still in flight' });
    }
    res.set('Idempotency-Replayed', 'true');
    return res.status(cached.status).json(cached.body);
  }

  idempotencyCache.set(cacheKey, { pending: true, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    idempotencyCache.set(cacheKey, {
      status: res.statusCode,
      body,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS
    });
    return originalJson(body);
  };
  next();
};

module.exports = { rejectAgentKeys, agentRateLimit, idempotent };
