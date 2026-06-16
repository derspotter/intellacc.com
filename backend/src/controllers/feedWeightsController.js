const db = require('../db');

const KEYS = ['accuracy', 'followers', 'likes', 'views'];

exports.getMyFeedWeights = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT w_accuracy, w_followers, w_likes, w_views FROM user_feed_weights WHERE user_id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(200).json({ weights: null });
    }
    const r = result.rows[0];
    res.status(200).json({
      weights: { accuracy: r.w_accuracy, followers: r.w_followers, likes: r.w_likes, views: r.w_views }
    });
  } catch (err) {
    console.error('Error getting feed weights:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.setMyFeedWeights = async (req, res) => {
  const body = req.body || {};
  const vals = {};
  for (const k of KEYS) {
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return res.status(400).json({ message: `Weight "${k}" must be an integer 0-100` });
    }
    vals[k] = n;
  }
  if (vals.accuracy + vals.followers + vals.likes + vals.views !== 100) {
    return res.status(400).json({ message: 'Weights must sum to 100' });
  }
  try {
    await db.query(
      `INSERT INTO user_feed_weights (user_id, w_accuracy, w_followers, w_likes, w_views, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         w_accuracy = EXCLUDED.w_accuracy, w_followers = EXCLUDED.w_followers,
         w_likes = EXCLUDED.w_likes, w_views = EXCLUDED.w_views, updated_at = NOW()`,
      [req.user.id, vals.accuracy, vals.followers, vals.likes, vals.views]
    );
    res.status(200).json({ weights: vals });
  } catch (err) {
    console.error('Error saving feed weights:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
