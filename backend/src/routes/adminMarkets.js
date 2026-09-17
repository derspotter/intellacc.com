const router = require('express').Router();
const db = require('../db');
const authenticateJWT = require('../middleware/auth');
const { requireAdmin } = authenticateJWT;
const questions = require('../controllers/marketQuestionController');
router.use(authenticateJWT, requireAdmin);

// Match public catalog visibility, including configured non-binary outcomes.
const visible = (alias) => `${alias}.hidden_at IS NULL AND (${alias}.event_type = 'binary' OR (SELECT count(*) FROM event_outcomes eo WHERE eo.event_id = ${alias}.id AND eo.is_active = TRUE) >= 2)`;

router.get('/', async (req, res) => {
  const queue = req.query.queue === 'proposals' ? 'proposals' : 'closed';
  const search = String(req.query.search || '').trim().slice(0, 200);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let client;
  try {
    client = await db.getPool().connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const summary = await client.query(`SELECT
      (SELECT count(*)::int FROM events e WHERE ${visible('e')} AND closing_date <= NOW() AT TIME ZONE 'UTC' AND outcome IS NULL) AS closed,
      (SELECT count(*)::int FROM market_question_submissions WHERE status = 'pending') AS proposals,
      (SELECT count(*)::int FROM market_question_submissions WHERE status = 'pending' AND closing_date <= NOW() AT TIME ZONE 'UTC') AS expired_proposals`);
    const from = queue === 'proposals' ? 'market_question_submissions m' : 'events m';
    const where = queue === 'proposals' ? "m.status = 'pending'" : ` ${visible('m')} AND m.closing_date <= NOW() AT TIME ZONE 'UTC' AND m.outcome IS NULL`;
    const filter = `${where} AND ($1 = '' OR m.title ILIKE '%' || $1 || '%' OR m.id::text = $1)`;
    const total = await client.query(`SELECT count(*)::int AS count FROM ${from} WHERE ${filter}`, [search]);
    const extra = queue === 'proposals'
      ? `m.creator_user_id, (SELECT username FROM users WHERE id = m.creator_user_id) AS creator_username,
         m.approvals, m.rejections, m.creator_bond_ledger, m.outcome_rows`
      : `m.hidden_at, m.outcome, (SELECT json_build_object('id', p.id, 'status', p.status, 'source_url', p.source_url, 'proposed_outcome', p.proposed_outcome)
          FROM market_resolution_proposals p WHERE p.event_id = m.id AND p.status IN ('voting', 'challenge_window', 'escalated') ORDER BY p.id DESC LIMIT 1) AS resolution_proposal`;
    const items = await client.query(`SELECT m.id, m.title, m.details, m.event_type,
      m.closing_date AT TIME ZONE 'UTC' AS closing_date, m.created_at AT TIME ZONE 'UTC' AS created_at, ${extra}
      FROM ${from} WHERE ${filter} ORDER BY m.closing_date ASC, m.id ASC LIMIT $2 OFFSET $3`, [search, limit, offset]);
    await client.query('COMMIT');
    res.json({ summary: summary.rows[0], items: items.rows, total: total.rows[0].count, limit, offset });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Admin market dashboard:', err);
    res.status(500).json({ message: 'Could not load the market dashboard' });
  } finally {
    client?.release();
  }
});
router.post('/proposals/:id/:decision', questions.adminDecision);
module.exports = router;
