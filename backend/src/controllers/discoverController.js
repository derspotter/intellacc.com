const db = require('../db');
const { buildPostVisibilityClause } = require('./postController');

const MIN_RESOLVED_IN_TOPIC = 5;
const PREDICTOR_LIMIT = 10;
const FEED_LIMIT = 20;

// Top predictors across the caller's topics: in-topic accuracy with a min-resolved
// threshold, padded with globally accurate users when sparse. Excludes the caller
// and users they already follow.
const topPredictorsFor = async (userId) => {
  const result = await db.query(
    `WITH my_topics AS (
       SELECT topic_id FROM user_topics WHERE user_id = $1
     ),
     excluded AS (
       SELECT following_id AS id FROM follows WHERE follower_id = $1
       UNION SELECT $1
     ),
     in_topic AS (
       SELECT p.user_id,
              COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) AS resolved,
              100.0 * COUNT(*) FILTER (WHERE LOWER(COALESCE(p.outcome, '')) = 'correct')
                / NULLIF(COUNT(*) FILTER (WHERE p.outcome IS NOT NULL), 0) AS accuracy_percent
       FROM predictions p
       JOIN event_topics et ON et.event_id = p.event_id
       JOIN my_topics mt ON mt.topic_id = et.topic_id
       GROUP BY p.user_id
       HAVING COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) >= $2
     ),
     global_acc AS (
       SELECT p.user_id,
              COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) AS resolved,
              100.0 * COUNT(*) FILTER (WHERE LOWER(COALESCE(p.outcome, '')) = 'correct')
                / NULLIF(COUNT(*) FILTER (WHERE p.outcome IS NOT NULL), 0) AS accuracy_percent
       FROM predictions p
       GROUP BY p.user_id
       HAVING COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) >= $2
     ),
     ranked AS (
       SELECT user_id, accuracy_percent, resolved, 0 AS tier FROM in_topic
       UNION ALL
       SELECT user_id, accuracy_percent, resolved, 1 AS tier FROM global_acc
       WHERE user_id NOT IN (SELECT user_id FROM in_topic)
     )
     SELECT u.id, u.username,
            ROUND(r.accuracy_percent::NUMERIC, 1)::DOUBLE PRECISION AS accuracy_percent,
            r.resolved::INT AS resolved_predictions,
            r.tier
     FROM ranked r
     JOIN users u ON u.id = r.user_id
     WHERE u.deleted_at IS NULL
       AND u.id NOT IN (SELECT id FROM excluded)
     ORDER BY r.tier ASC, r.accuracy_percent DESC, r.resolved DESC
     LIMIT $3`,
    [userId, MIN_RESOLVED_IN_TOPIC, PREDICTOR_LIMIT]
  );
  return result.rows;
};

exports.getPredictors = async (req, res) => {
  try {
    res.json({ predictors: await topPredictorsFor(req.user.id) });
  } catch (err) {
    console.error('Error fetching discover predictors:', err);
    res.status(500).json({ message: 'Failed to fetch predictors' });
  }
};

exports.getFeed = async (req, res) => {
  try {
    const predictors = await topPredictorsFor(req.user.id);
    if (predictors.length === 0) return res.json({ items: [], predictors: [] });

    // $1 = viewer id, $2 = predictor ids array, $3 = feed limit
    // buildPostVisibilityClause('$1') applies: is_hidden=FALSE + no block relationship
    // This matches the same filter used in postController getFeed/getPosts.
    const result = await db.query(
      `SELECT p.*, u.username, u.avatar_url,
              CASE WHEN EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1)
                   THEN true ELSE false END AS liked_by_user
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id = ANY($2::int[])
         AND p.parent_id IS NULL
         AND p.is_comment = FALSE
         AND ${buildPostVisibilityClause('$1')}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $3`,
      [req.user.id, predictors.map((p) => p.id), FEED_LIMIT]
    );
    res.json({ items: result.rows, predictors });
  } catch (err) {
    console.error('Error fetching discover feed:', err);
    res.status(500).json({ message: 'Failed to fetch discover feed' });
  }
};
