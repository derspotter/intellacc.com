// Durable per-user generation budget shared by public replies, private chats
// and settings tests. Every reserved attempt counts (also failed ones), which
// keeps retry loops from turning into unbounded spend on the user's key.
const clampInt = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const BUDGET = Object.freeze({
  perHour: clampInt(process.env.AI_MAX_REQUESTS_PER_HOUR, 30, 1, 1000),
  perDay: clampInt(process.env.AI_MAX_REQUESTS_PER_DAY, 200, 1, 10000),
  concurrent: clampInt(process.env.AI_MAX_CONCURRENT, 2, 1, 10),
  // A generation older than this is treated as crashed/ambiguous.
  staleGenerationSeconds: 300
});

class AiBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiBudgetError';
    this.code = code;
    this.status = 429;
  }
}

// Must run inside the caller's transaction. The settings row lock serializes
// concurrent reservations for one user; `selfIncluded` tells the check that
// the caller's own work item is already counted as active.
const reserve = async (client, userId, kind, { selfIncluded = false } = {}) => {
  const lock = await client.query('SELECT user_id FROM user_ai_settings WHERE user_id = $1 FOR UPDATE', [userId]);
  if (lock.rows.length === 0) throw new AiBudgetError('not_configured', 'Configure an AI provider first');

  const active = (await client.query(
    `SELECT (SELECT COUNT(*)::int FROM ai_conversations
              WHERE user_id = $1 AND generation_request_id IS NOT NULL
                AND generation_started_at > NOW() - ($2 * INTERVAL '1 second'))
          + (SELECT COUNT(*)::int FROM ai_public_reply_jobs
              WHERE requester_user_id = $1 AND status = 'running' AND locked_until > NOW())
          + (SELECT COUNT(*)::int FROM ai_usage_events WHERE user_id = $1 AND active_until > NOW()) AS active`,
    [userId, BUDGET.staleGenerationSeconds]
  )).rows[0]?.active ?? 0;
  if (active - (selfIncluded ? 1 : 0) >= BUDGET.concurrent) {
    throw new AiBudgetError('too_many_active', 'Another AI request is still running; wait for it to finish');
  }

  const usage = (await client.query(
    `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS hour,
            COUNT(*)::int AS day
     FROM ai_usage_events WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId]
  )).rows[0] || { hour: 0, day: 0 };
  if (usage.hour >= BUDGET.perHour) throw new AiBudgetError('rate_limited', `Hourly AI limit reached (${BUDGET.perHour} requests)`);
  if (usage.day >= BUDGET.perDay) throw new AiBudgetError('rate_limited', `Daily AI limit reached (${BUDGET.perDay} requests)`);

  const reservation = await client.query(
    `INSERT INTO ai_usage_events (user_id, kind, active_until)
     VALUES ($1, $2, CASE WHEN $2 = 'test' THEN NOW() + INTERVAL '180 seconds' ELSE NULL END) RETURNING id`,
    [userId, kind]
  );
  return reservation.rows[0]?.id;
};

module.exports = { BUDGET, AiBudgetError, reserve };
