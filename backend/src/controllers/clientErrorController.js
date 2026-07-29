const db = require('../db');

// Sink for the frontend error reporter (src/services/errorReporter.js).
// Unauthenticated by design — errors happen on logged-out pages too — so the
// route is hard-rate-limited and every field is truncated server-side.
const clip = (value, max) =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;

const reportClientError = async (req, res) => {
  try {
    const message = clip(req.body?.message, 500);
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    await db.query(
      `INSERT INTO client_errors (user_id, message, stack, url, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user?.id || null,
        message,
        clip(req.body?.stack, 4000),
        clip(req.body?.url, 300),
        clip(req.headers['user-agent'], 300)
      ]
    );
    res.status(204).end();
  } catch (err) {
    // Never let the error sink produce user-visible failures.
    console.error('[client-errors] insert failed:', err.message);
    res.status(204).end();
  }
};

module.exports = { reportClientError };
