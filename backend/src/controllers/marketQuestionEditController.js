const db = require('../db');

// Review and publication use the same submission lock, so they cannot race an edit.
exports.updateSubmission = async (req, res) => {
  const id = Number(req.params.id);
  const { title, details, category = null, closing_date: closingDate } = req.body || {};
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid submission id' });
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ message: 'title is required' });
  if (typeof details !== 'string' || !details.trim()) return res.status(400).json({ message: 'details is required' });
  if (category !== null && typeof category !== 'string') return res.status(400).json({ message: 'category must be text' });
  const date = typeof closingDate === 'string' ? new Date(closingDate) : new Date(NaN);
  if (!Number.isFinite(date.getTime()) || date <= new Date()) {
    return res.status(400).json({ message: 'Closing date must be a valid date in the future' });
  }
  let client;
  try {
    client = await db.getPool().connect();
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM market_question_submissions WHERE id = $1 FOR UPDATE', [id]);
    const submission = result.rows[0];
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    if (!submission) fail(404, 'Submission not found');
    if (Number(submission.creator_user_id) !== Number(req.user.id)) fail(403, 'Only the creator can edit this proposal');
    if (submission.status !== 'pending' || submission.approved_event_id) fail(409, 'Only pending proposals can be edited');
    const reviews = await client.query('SELECT 1 FROM market_question_reviews WHERE submission_id = $1 LIMIT 1', [id]);
    if (reviews.rows.length || Number(submission.total_reviews) > 0 || Number(submission.approvals) > 0 || Number(submission.rejections) > 0) {
      fail(409, 'This proposal has already received reviews and can no longer be edited');
    }
    await client.query(
      `UPDATE market_question_submissions SET title = $2, details = $3, category = $4,
       closing_date = $5, updated_at = NOW() WHERE id = $1`,
      [id, title.trim(), details.trim(), category?.trim() || null, date.toISOString()]
    );
    await client.query('COMMIT');
    res.json({ message: 'Proposal updated', id });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    if (!err.status) console.error('Error editing market proposal:', err);
    res.status(err.status || 500).json({ message: err.status ? err.message : 'Failed to update proposal' });
  } finally {
    client?.release();
  }
};
