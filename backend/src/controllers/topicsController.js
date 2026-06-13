const db = require('../db');

const MIN_TOPICS = 3;

exports.listTopics = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, slug, name, description, display_order
       FROM topics WHERE is_user_facing = TRUE
       ORDER BY display_order NULLS LAST, id`
    );
    res.json({ topics: result.rows });
  } catch (err) {
    console.error('Error listing topics:', err);
    res.status(500).json({ message: 'Failed to list topics' });
  }
};

exports.getMyTopics = async (req, res) => {
  try {
    const result = await db.query('SELECT topic_id FROM user_topics WHERE user_id = $1', [req.user.id]);
    res.json({ topicIds: result.rows.map((r) => r.topic_id) });
  } catch (err) {
    console.error('Error fetching user topics:', err);
    res.status(500).json({ message: 'Failed to fetch topics' });
  }
};

exports.setMyTopics = async (req, res) => {
  const topicIds = Array.isArray(req.body?.topicIds)
    ? [...new Set(req.body.topicIds.map(Number).filter(Number.isInteger))]
    : [];
  if (topicIds.length < MIN_TOPICS) {
    return res.status(400).json({ message: `Pick at least ${MIN_TOPICS} topics` });
  }

  // Validate all ids are known user-facing topics before opening a transaction
  const valid = await db.query(
    'SELECT id FROM topics WHERE is_user_facing = TRUE AND id = ANY($1::int[])',
    [topicIds]
  ).catch((err) => {
    console.error('Error validating topic ids:', err);
    return null;
  });

  if (!valid) {
    return res.status(500).json({ message: 'Failed to set topics' });
  }

  if (valid.rows.length !== topicIds.length) {
    return res.status(400).json({ message: 'Unknown topic id' });
  }

  try {
    await db.executeWithTransaction(async (client) => {
      await client.query('DELETE FROM user_topics WHERE user_id = $1', [req.user.id]);
      await client.query(
        `INSERT INTO user_topics (user_id, topic_id) SELECT $1, UNNEST($2::int[])`,
        [req.user.id, topicIds]
      );
    });
    res.json({ topicIds });
  } catch (err) {
    console.error('Error setting user topics:', err);
    res.status(500).json({ message: 'Failed to set topics' });
  }
};
