const db = require('../db');

const isValidReportType = (type) => ['post', 'comment', 'user'].includes(type);

const sanitizeText = (value) => {
  if (!value || typeof value !== 'string') return '';
  return value.trim();
};

const requireAdmin = (req) => {
  if (!req.user || req.user.role !== 'admin') {
    return false;
  }
  return true;
};

const normalizeLimit = (rawLimit) => {
  const parsed = parseInt(rawLimit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 100;
  }
  return Math.min(parsed, 200);
};

exports.createReport = async (req, res) => {
  const reporterId = req.user?.id;
  const reportedContentType = sanitizeText(req.body?.content_type);
  const reportedContentId = parseInt(req.body?.content_id, 10);
  const reason = sanitizeText(req.body?.reason);
  const details = sanitizeText(req.body?.details);
  const reportedUserIdRaw = req.body?.reported_user_id;

  if (!isValidReportType(reportedContentType)) {
    return res.status(400).json({ message: 'Invalid content type' });
  }

  if (!reason) {
    return res.status(400).json({ message: 'Report reason is required' });
  }

  if (reportedContentType === 'user' && !reportedUserIdRaw) {
    return res.status(400).json({ message: 'reported_user_id is required for user reports' });
  }

  if (reportedContentType !== 'user' && !reportedContentId) {
    return res.status(400).json({ message: 'content_id is required for post/comment reports' });
  }

  try {
    let reportedUserId;

    if (reportedContentType === 'user') {
      const parsedUserId = parseInt(reportedUserIdRaw, 10);
      if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
        return res.status(400).json({ message: 'Invalid reported_user_id' });
      }
      if (parsedUserId === reporterId) {
        return res.status(400).json({ message: 'You cannot report yourself' });
      }
      const userResult = await db.query('SELECT id FROM users WHERE id = $1', [parsedUserId]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({ message: 'Reported user not found' });
      }
      reportedUserId = parsedUserId;
    } else {
      if (!Number.isInteger(reportedContentId) || reportedContentId <= 0) {
        return res.status(400).json({ message: 'Invalid content_id' });
      }

      const contentResult = await db.query(
        `SELECT id, user_id, is_comment
         FROM posts
         WHERE id = $1`,
        [reportedContentId]
      );

      if (contentResult.rows.length === 0) {
        return res.status(404).json({ message: 'Reported content not found' });
      }

      const target = contentResult.rows[0];
      const isComment = target.is_comment === true;
      if ((reportedContentType === 'comment' && !isComment) || (reportedContentType === 'post' && isComment)) {
        return res.status(400).json({ message: `content_id is not a ${reportedContentType}` });
      }

      if (target.user_id === reporterId) {
        return res.status(400).json({ message: 'You cannot report your own content' });
      }

      reportedUserId = target.user_id;
    }

    const result = await db.query(
      `INSERT INTO moderation_reports
       (reporter_id, reported_user_id, reported_content_type, reported_content_id, report_reason, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
        [
        reporterId,
        reportedUserId,
        reportedContentType,
        reportedContentType === 'user' ? null : reportedContentId,
        reason,
        details || null
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(404).json({ message: 'Reported target not found' });
    }

    if (err.code === '23514') {
      return res.status(400).json({ message: err.message || 'Invalid report payload' });
    }

    console.error('Error creating report:', err);
    return res.status(500).json({ error: 'Failed to create report' });
  }
};

exports.getReports = async (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const limit = normalizeLimit(req.query.limit);
  const status = sanitizeText(req.query.status || 'open');
  const contentType = sanitizeText(req.query.content_type);

  try {
    const where = [];
    const values = [limit];

    if (status) {
      values.push(status);
      where.push(`r.status = $${values.length}`);
    }

    if (contentType) {
      if (!isValidReportType(contentType)) {
        return res.status(400).json({ message: 'Invalid content_type filter' });
      }
      values.push(contentType);
      where.push(`r.reported_content_type = $${values.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT
         r.id,
         r.reported_content_type,
         r.reported_content_id,
         r.report_reason,
         r.details,
         r.status,
         r.reviewed_at,
         r.reviewed_by,
         r.review_action,
         r.review_note,
         r.created_at,
         r.reporter_id,
         reporter.username AS reporter_username,
         reported.username AS reported_username,
         (CASE
            WHEN r.reported_content_type IN ('post', 'comment')
              THEN (SELECT content FROM posts WHERE id = r.reported_content_id LIMIT 1)
            ELSE NULL
          END) AS reported_content
       FROM moderation_reports r
       JOIN users reporter ON reporter.id = r.reporter_id
       JOIN users reported ON reported.id = r.reported_user_id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $1`,
      values
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error loading moderation reports:', err);
    return res.status(500).json({ error: 'Failed to load moderation reports' });
  }
};

exports.reviewReport = async (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const reportId = parseInt(req.params.id, 10);
  const action = sanitizeText(req.body?.action);
  const note = sanitizeText(req.body?.note);

  if (!Number.isInteger(reportId) || reportId <= 0) {
    return res.status(400).json({ message: 'Invalid report id' });
  }

  if (!['dismiss', 'hide_content', 'no_action'].includes(action)) {
    return res.status(400).json({ message: 'Invalid action' });
  }

  const resolvedStatus = action === 'dismiss' ? 'dismissed' : 'resolved';

  try {
    const reportResult = await db.query(
      'SELECT * FROM moderation_reports WHERE id = $1',
      [reportId]
    );

    if (reportResult.rows.length === 0) {
      return res.status(404).json({ message: 'Report not found' });
    }

    const report = reportResult.rows[0];
    if (report.status !== 'open') {
      return res.status(409).json({ message: 'Report already reviewed' });
    }

    if (action === 'hide_content' && report.reported_content_type === 'user') {
      return res.status(400).json({ message: 'hide_content is not supported for user reports' });
    }

    if (action === 'hide_content' && report.reported_content_type !== 'user') {
      await db.query(
        `UPDATE posts
         SET is_hidden = TRUE
         WHERE id = $1`,
        [report.reported_content_id]
      );
    }

    const updateResult = await db.query(
      `UPDATE moderation_reports
       SET status = $1,
           review_action = $2,
           review_note = $3,
           reviewed_by = $4,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [resolvedStatus, action, note || null, req.user.id, reportId]
    );

    return res.status(200).json(updateResult.rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ message: 'Invalid report payload' });
    }

    console.error('Error reviewing report:', err);
    return res.status(500).json({ error: 'Failed to review report' });
  }
};
