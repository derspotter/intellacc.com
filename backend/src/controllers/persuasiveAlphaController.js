const db = require('../db');

const DEFAULT_CLICK_TTL_MINUTES = 30;

const parseIntParam = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
};

const parseClickWindowMinutes = () => {
  const configured = Number(process.env.POST_MARKET_CLICK_TTL_MINUTES);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_CLICK_TTL_MINUTES;
  }
  return configured;
};

exports.createPostMarketClick = async (req, res) => {
  try {
    const postId = parseIntParam(req.params.postId, 'postId');
    const eventId = parseIntParam(req.body?.event_id, 'event_id');
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const postResult = await db.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const eventResult = await db.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid event_id' });
    }

    const matchResult = await db.query(
      `SELECT 1
       FROM post_market_matches
       WHERE post_id = $1
         AND event_id = $2
       LIMIT 1`,
      [postId, eventId]
    );
    if (matchResult.rows.length === 0) {
      return res.status(400).json({ message: 'No active market match for this post' });
    }

    const now = Date.now();
    const ttlMinutes = parseClickWindowMinutes();
    const expiresAt = new Date(now + ttlMinutes * 60 * 1000);
    await db.query(
      `DELETE FROM post_market_clicks
       WHERE post_id = $1
         AND event_id = $2
         AND user_id = $3
         AND consumed_by_market_update_id IS NULL
         AND consumed_at IS NULL
         AND expires_at <= NOW()`,
      [postId, eventId, userId]
    );

    let insertResult;
    try {
      insertResult = await db.query(
        `INSERT INTO post_market_clicks (
           post_id,
           event_id,
           user_id,
           clicked_at,
           expires_at
         ) VALUES ($1, $2, $3, NOW(), $4)
         RETURNING id, clicked_at, expires_at`,
        [postId, eventId, userId, expiresAt]
      );
    } catch (insertError) {
      if (insertError.code !== '23505') {
        throw insertError;
      }

      const duplicateResult = await db.query(
        `SELECT id, clicked_at, expires_at
           FROM post_market_clicks
          WHERE post_id = $1
            AND event_id = $2
            AND user_id = $3
            AND consumed_at IS NULL
            AND consumed_by_market_update_id IS NULL
            AND expires_at > NOW()
          ORDER BY clicked_at DESC
          LIMIT 1`,
        [postId, eventId, userId]
      );

      if (duplicateResult.rows.length === 0) {
        throw insertError;
      }

      return res.status(200).json({
        success: true,
        click: duplicateResult.rows[0]
      });
    }

    res.status(201).json({
      success: true,
      click: insertResult.rows[0]
    });
  } catch (error) {
    if (error.message.startsWith('Invalid ')) {
      return res.status(400).json({ message: error.message });
    }
    console.error('Error creating post market click:', error);
    res.status(500).json({ message: 'Failed to register market click' });
  }
};

exports.getPostMarkets = async (req, res) => {
  try {
    const postId = parseIntParam(req.params.postId, 'postId');

    const result = await db.query(
      `SELECT
         pm.event_id,
         e.title,
         e.market_prob,
         pm.match_score,
         pm.match_method,
         e.outcome,
         e.closing_date
       FROM post_market_matches pm
       JOIN events e ON e.id = pm.event_id
       WHERE pm.post_id = $1
       ORDER BY pm.match_score DESC, pm.event_id ASC`,
      [postId]
    );

    res.json({
      post_id: postId,
      markets: result.rows
    });
  } catch (error) {
    if (error.message.startsWith('Invalid ')) {
      return res.status(400).json({ message: error.message });
    }
    console.error('Error loading post markets:', error);
    res.status(500).json({ message: 'Failed to load post markets' });
  }
};
