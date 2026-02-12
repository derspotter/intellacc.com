const db = require('../../db');
const { publishPost } = require('./publisherService');

const DEFAULT_INTERVAL_MS = 15 * 1000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_ATTEMPTS = 8;

const computeNextAttemptAt = (attemptCount) => {
  const baseSeconds = 45;
  const exp = Math.min(attemptCount - 1, 8);
  const seconds = Math.min(baseSeconds * (2 ** exp), 2 * 60 * 60);
  const jitter = Math.floor(Math.random() * 15);
  return new Date(Date.now() + (seconds + jitter) * 1000);
};

const markDeliveryResult = async ({ id, status, httpStatus, errorText, nextAttemptAt }) => {
  await db.query(
    `UPDATE atproto_delivery_queue
     SET status = $2,
         delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END,
         next_attempt_at = COALESCE($5, next_attempt_at),
         last_status_code = $3,
         last_error = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [id, status, httpStatus || null, errorText || null, nextAttemptAt || null]
  );
};

const loadPost = async (userId, postId) => {
  const result = await db.query(
    `SELECT id, user_id, content, image_url, created_at, parent_id, is_comment
     FROM posts
     WHERE id = $1
       AND user_id = $2`,
    [postId, userId]
  );
  return result.rows[0] || null;
};

const processDueDeliveries = async (limit = DEFAULT_BATCH_SIZE) => {
  const pool = db.getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `WITH claimed AS (
         SELECT id
         FROM atproto_delivery_queue
         WHERE status = 'pending'
           AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE atproto_delivery_queue q
       SET attempt_count = attempt_count + 1,
           last_attempt_at = NOW(),
           updated_at = NOW()
       FROM claimed
       WHERE q.id = claimed.id
       RETURNING q.id, q.user_id, q.post_id, q.kind, q.attempt_count`,
      [limit]
    );
    await client.query('COMMIT');

    let processed = 0;

    for (const row of claimed.rows) {
      processed += 1;

      try {
        const post = await loadPost(row.user_id, row.post_id);
        if (!post) {
          await markDeliveryResult({
            id: row.id,
            status: 'dead',
            errorText: 'Local post not found',
            httpStatus: 404
          });
          continue;
        }

        const result = await publishPost({
          userId: row.user_id,
          post
        });

        await markDeliveryResult({
          id: row.id,
          status: 'delivered',
          httpStatus: result.skipped ? 204 : 200,
          errorText: null
        });
      } catch (err) {
        const terminal = row.attempt_count >= MAX_ATTEMPTS || err?.code === 'ATPROTO_NO_ACCOUNT';
        await markDeliveryResult({
          id: row.id,
          status: terminal ? 'dead' : 'pending',
          httpStatus: err?.statusCode || null,
          errorText: String(err?.message || 'ATProto delivery failed').slice(0, 500),
          nextAttemptAt: terminal ? null : computeNextAttemptAt(row.attempt_count)
        });
      }
    }

    return processed;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
};

const startDeliveryWorker = ({ intervalMs = DEFAULT_INTERVAL_MS } = {}) => {
  const timer = setInterval(async () => {
    try {
      await processDueDeliveries();
    } catch (err) {
      console.error('[ATProtoDelivery] Worker error:', err?.message || err);
    }
  }, intervalMs);
  timer.unref();
};

module.exports = {
  processDueDeliveries,
  startDeliveryWorker
};
