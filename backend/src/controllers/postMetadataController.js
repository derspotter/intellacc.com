const db = require('../db');
const { buildPostVisibilityClause } = require('./postController');

// Bound both the SQL work and response size. The client chunks larger pages.
exports.getBatch = async (req, res) => {
  const ids = req.body?.post_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100
      || ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
      || (req.body.status_only !== undefined && typeof req.body.status_only !== 'boolean')) {
    return res.status(400).json({ message: 'Provide 1 to 100 valid post_ids and an optional boolean status_only' });
  }
  const statusOnly = req.body.status_only === true;
  // Match feed semantics: administrators bypass blocks, never hidden posts.
  const viewer = req.user.role === 'admin' ? null : (req.user.id ?? req.user.userId);
  try {
    const result = await db.query(`
      SELECT p.id AS post_id,
        jsonb_build_object('processing_status', COALESCE(pa.processing_status, 'not_started'),
                           'updated_at', pa.updated_at) AS status
        ${statusOnly ? '' : `,
        link.data AS link,
        COALESCE(markets.data, '[]'::jsonb) AS markets,
        jsonb_build_object('episode_count', signal.episode_count,
          'market_count', signal.market_count, 'max_prob_move', signal.max_prob_move,
          'reward_rp', signal.reward_rp) AS signal`}
      FROM posts p
      LEFT JOIN post_analysis pa ON pa.post_id = p.id
      ${statusOnly ? '' : `
      LEFT JOIN LATERAL (
        SELECT to_jsonb(candidate) AS data FROM (
          SELECT pml.event_id, pml.match_confidence, pml.stance, pml.source,
                 pml.confirmed, pml.match_score, pml.match_method,
                 pml.flagged_count, pml.confirmed_count,
                 e.title, e.outcome, e.closing_date, e.market_prob
          FROM post_market_links pml JOIN events e ON e.id = pml.event_id
          WHERE pml.post_id = p.id AND e.hidden_at IS NULL
          ORDER BY pml.confirmed DESC, pml.updated_at DESC NULLS LAST, pml.id DESC
          LIMIT 1
        ) candidate
      ) link ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(candidate ORDER BY candidate.match_score DESC, candidate.event_id) AS data FROM (
          SELECT pm.event_id, e.title, e.market_prob, pm.match_score,
                 pm.match_method, e.outcome, e.closing_date
          FROM post_market_matches pm JOIN events e ON e.id = pm.event_id
          WHERE pm.post_id = p.id AND e.hidden_at IS NULL
          ORDER BY pm.match_score DESC, pm.event_id ASC LIMIT 3
        ) candidate
      ) markets ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT pse.id)::int AS episode_count, COUNT(DISTINCT pse.event_id)::int AS market_count,
          COALESCE(MAX(ABS(pse.p_after - pse.p_before)), 0)::double precision AS max_prob_move,
          (COALESCE(SUM(pay.reward_ledger), 0) / 1000000.0)::double precision AS reward_rp
        FROM post_signal_episodes pse
        JOIN events e ON e.id = pse.event_id AND e.hidden_at IS NULL
        LEFT JOIN post_signal_reward_payouts pay ON pay.episode_id = pse.id
        WHERE pse.post_id = p.id AND pse.is_meaningful
      ) signal ON TRUE`}
      WHERE p.id = ANY($1::int[]) AND ${buildPostVisibilityClause('$2')}
      ORDER BY p.id`, [[...new Set(ids)], viewer]);
    res.json({ posts: result.rows });
  } catch (error) {
    console.error('Error loading post metadata:', error);
    res.status(500).json({ message: 'Failed to load post metadata' });
  }
};
