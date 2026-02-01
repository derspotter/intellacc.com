/**
 * AI Moderation Controller
 * Lists AI-flagged content for admins
 */
const db = require('../db');

const isAdmin = async (req) => {
  if (req.user?.role === 'admin') return true;

  const result = await db.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
  return result.rows[0]?.role === 'admin';
};

exports.getFlaggedContent = async (req, res) => {
  try {
    const admin = await isAdmin(req);
    if (!admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const contentType = req.query.content_type;
    const params = [limit];
    let typeClause = '';

    if (contentType) {
      params.push(contentType);
      typeClause = 'AND c.content_type = $2';
    }

    const result = await db.query(
      `SELECT
          c.id as analysis_id,
          c.content_type,
          c.content_id,
          c.user_id,
          c.ai_probability,
          c.detected_model,
          c.is_flagged,
          c.analyzed_at,
          u.username,
          u.bio as user_bio,
          p.content,
          p.created_at,
          p.parent_id,
          p.is_comment
       FROM content_ai_analysis c
       JOIN users u ON c.user_id = u.id
       LEFT JOIN posts p
         ON c.content_type IN ('post', 'comment')
        AND c.content_id = p.id
       WHERE c.is_flagged = TRUE
       ${typeClause}
       ORDER BY c.analyzed_at DESC
       LIMIT $1`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[AiModerationController] Error:', err);
    res.status(500).json({ error: 'Failed to load flagged content' });
  }
};
