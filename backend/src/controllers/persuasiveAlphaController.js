const db = require('../db');

const DEFAULT_CLICK_TTL_MINUTES = 30;
const VALID_CONFIRM_ACTIONS = new Set(['confirm', 'override']);
const VALID_VERIFY_ACTIONS = new Set([
  'confirm_market_match',
  'reject_market_match',
  'suggest_market',
  'confirm_logic',
  'reject_logic',
  'flag_critique_helpful',
  'flag_critique_wrong'
]);

const parseIntParam = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
};

const isRelationMissingError = (error) => error?.code === '42P01';

const normalizeOptionalTableResult = (error, res, fallback) => {
  if (!isRelationMissingError(error)) {
    return false;
  }

  return res.status(503).json({
    ...fallback,
    enabled: false,
    message: 'Market matching is not enabled in this environment.'
  });
};

const parseClickWindowMinutes = () => {
  const configured = Number(process.env.POST_MARKET_CLICK_TTL_MINUTES);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_CLICK_TTL_MINUTES;
  }
  return configured;
};

const normalizeEventPayload = (row, prefix = '') => {
  if (!row) return null;

  const eventTitle = row[`${prefix}title`] || null;
  return {
    event_id: Number(row.event_id),
    title: row.title || eventTitle,
    match_score: Number(row.match_score) || 0,
    match_method: row.match_method || null,
    stance: row.stance || null,
    match_confidence: row.match_confidence == null ? null : Number(row.match_confidence),
    source: row.source || null,
    confirmed: !!row.confirmed,
    flagged_count: Number(row.flagged_count || 0),
    confirmed_count: Number(row.confirmed_count || 0),
    event: {
      id: Number(row.event_id),
      title: eventTitle,
      outcome: row.outcome,
      closing_date: row.closing_date
    }
  };
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
    const missingTableResponse = normalizeOptionalTableResult(error, res);
    if (missingTableResponse) {
      return missingTableResponse;
    }

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
    const missingTableResponse = normalizeOptionalTableResult(error, res, {
      post_id: Number(req.params.postId),
      markets: []
    });
    if (missingTableResponse) {
      return missingTableResponse;
    }

    if (error.message.startsWith('Invalid ')) {
      return res.status(400).json({ message: error.message });
    }
    console.error('Error loading post markets:', error);
    res.status(500).json({ message: 'Failed to load post markets' });
  }
};

exports.getPostMarketLink = async (req, res) => {
  const requestedPostId = Number(req.params.postId);
  try {
    const postId = parseIntParam(req.params.postId, 'postId');

    const postResult = await db.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const confirmedLinks = await db.query(
      `SELECT
         pml.id,
         pml.event_id,
         pml.match_confidence,
         pml.stance,
         pml.source,
         pml.confirmed,
         pml.match_score,
         pml.match_method,
         pml.flagged_count,
         pml.confirmed_count,
         e.title,
         e.outcome,
         e.closing_date
       FROM post_market_links pml
       JOIN events e ON e.id = pml.event_id
       WHERE pml.post_id = $1
       ORDER BY pml.confirmed DESC,
                pml.updated_at DESC NULLS LAST,
                pml.id DESC
       LIMIT 1`,
      [postId]
    );

    if (confirmedLinks.rows.length > 0) {
      return res.json({
        post_id: postId,
        linked_market: normalizeEventPayload(confirmedLinks.rows[0])
      });
    }

    const analysisRow = await db.query(
      `SELECT has_claim, processing_status, candidates_count, claim_summary, domain
         FROM post_analysis
        WHERE post_id = $1`,
      [postId]
    );

    const matchRows = await db.query(
      `SELECT
         pm.event_id,
         pm.match_score,
         pm.match_method,
         e.title,
         e.outcome,
         e.closing_date
       FROM post_market_matches pm
       JOIN events e ON e.id = pm.event_id
       WHERE pm.post_id = $1
       ORDER BY pm.match_score DESC, pm.id DESC
       LIMIT 1`,
      [postId]
    );

    res.json({
      post_id: postId,
      has_claim: analysisRow.rows[0]?.has_claim === true,
      processing_status: analysisRow.rows[0]?.processing_status || 'complete',
      candidates_count: Number(analysisRow.rows[0]?.candidates_count || 0),
      claim_summary: analysisRow.rows[0]?.claim_summary || null,
      domain: analysisRow.rows[0]?.domain || null,
      linked_market: null,
      top_candidate: normalizeEventPayload(matchRows.rows[0])
    });
  } catch (error) {
    const fallbackPostId = Number.isInteger(requestedPostId) ? requestedPostId : null;
    if (error.message.startsWith('Invalid ')) {
      return res.status(400).json({ message: error.message });
    }

    if (isRelationMissingError(error)) {
      return res.status(200).json({
        post_id: fallbackPostId,
        has_claim: false,
        processing_status: 'not_started',
        candidates_count: 0,
        linked_market: null,
        top_candidate: null
      });
    }

    console.error('Error loading post market link:', error);
    res.status(500).json({ message: 'Failed to load post market link' });
  }
};

exports.confirmMarketLink = async (req, res) => {
  try {
    const postId = parseIntParam(req.params.postId, 'postId');
    const eventId = parseIntParam(req.body?.event_id, 'event_id');
    const action = String(req.body?.action || 'confirm');
    const userId = req.user?.id || req.user?.userId;
    const stance = ['agrees', 'disagrees', 'related'].includes(req.body?.stance)
      ? req.body.stance
      : 'related';
    const matchConfidence = req.body?.match_confidence;

    if (!VALID_CONFIRM_ACTIONS.has(action)) {
      return res.status(400).json({ message: 'Invalid action' });
    }

    const postResult = await db.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (postResult.rows[0].user_id !== Number(userId)) {
      return res.status(403).json({ message: 'Not allowed to confirm links for this post' });
    }

    const eventResult = await db.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid event_id' });
    }

    const candidateResult = await db.query(
      `SELECT 1
         FROM post_market_matches
        WHERE post_id = $1 AND event_id = $2
       LIMIT 1`,
      [postId, eventId]
    );
    if (candidateResult.rows.length === 0) {
      return res.status(400).json({ message: 'No active match for this event' });
    }

    await db.query('BEGIN');

    try {
      if (action === 'override') {
        await db.query(
          `UPDATE post_market_links
             SET confirmed = FALSE,
                 source = CASE
                   WHEN source = 'author_confirmed' THEN 'author_overridden'
                   WHEN source = 'author_overridden' THEN 'author_overridden'
                   ELSE source
                 END,
                 updated_at = NOW()
           WHERE post_id = $1
             AND source = 'author_confirmed'`,
          [postId]
        );
      }

      const upsertResult = await db.query(
        `INSERT INTO post_market_links (
           post_id,
           event_id,
           stance,
           source,
           confirmed,
           match_confidence,
           confirmed_count
         ) VALUES ($1, $2, $3, $4, TRUE, $5, 1)
         ON CONFLICT (post_id, event_id) DO UPDATE
         SET stance = EXCLUDED.stance,
             source = EXCLUDED.source,
             confirmed = TRUE,
             match_confidence = EXCLUDED.match_confidence,
             confirmed_count = post_market_links.confirmed_count + 1,
             updated_at = NOW()
         RETURNING *`,
        [
          postId,
          eventId,
          stance,
          action === 'override' ? 'author_overridden' : 'author_confirmed',
          matchConfidence == null ? null : Number(matchConfidence)
        ]
      );

      await db.query(
        `INSERT INTO verification_actions (
           user_id,
           post_id,
           action_type,
           target_link_id,
           target_event_id
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          userId,
          postId,
          action === 'override' ? 'reject_market_match' : 'confirm_market_match',
          upsertResult.rows[0]?.id || null,
          action === 'override' ? null : eventId
        ]
      );

      await db.query('COMMIT');

      return res.status(200).json({
        post_id: postId,
        action,
        linked_market: normalizeEventPayload(upsertResult.rows[0])
      });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    const missingTableResponse = normalizeOptionalTableResult(error, res);
    if (missingTableResponse) {
      return missingTableResponse;
    }

    if (error.message.startsWith('Invalid ')) {
      return res.status(400).json({ message: error.message });
    }
    console.error('Error confirming market link:', error);
    res.status(500).json({ message: 'Failed to confirm market link' });
  }
};

exports.submitVerification = async (req, res) => {
  try {
    const postId = parseIntParam(req.params.postId, 'postId');
    const actionType = req.body?.action_type;
    const targetLinkId = req.body?.target_link_id != null
      ? parseIntParam(req.body.target_link_id, 'target_link_id')
      : null;
    const targetEventId = req.body?.target_event_id != null
      ? parseIntParam(req.body.target_event_id, 'target_event_id')
      : null;
    const userId = req.user?.id || req.user?.userId;

    if (!VALID_VERIFY_ACTIONS.has(actionType)) {
      return res.status(400).json({ message: 'Invalid action_type' });
    }

    const postResult = await db.query(
      'SELECT id FROM posts WHERE id = $1',
      [postId]
    );
    if (postResult.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    let resolvedLinkId = targetLinkId;
    if (actionType === 'confirm_market_match' || actionType === 'reject_market_match') {
      if (!resolvedLinkId && targetEventId) {
        const linkResult = await db.query(
          `SELECT id FROM post_market_links
            WHERE post_id = $1 AND event_id = $2
            ORDER BY created_at DESC
            LIMIT 1`,
          [postId, targetEventId]
        );

        if (linkResult.rows.length === 0) {
          return res.status(400).json({ message: 'Target link not found' });
        }

        resolvedLinkId = linkResult.rows[0].id;
      }

      if (!resolvedLinkId) {
        return res.status(400).json({ message: 'target_link_id or target_event_id is required' });
      }

      const linkOwnerResult = await db.query(
        'SELECT 1 FROM post_market_links WHERE id = $1 AND post_id = $2',
        [resolvedLinkId, postId]
      );
      if (linkOwnerResult.rows.length === 0) {
        return res.status(400).json({ message: 'Target link does not belong to this post' });
      }
    }

    if (actionType === 'suggest_market') {
      if (!targetEventId) {
        return res.status(400).json({ message: 'target_event_id is required for suggest_market' });
      }

      const eventResult = await db.query('SELECT id FROM events WHERE id = $1', [targetEventId]);
      if (eventResult.rows.length === 0) {
        return res.status(400).json({ message: 'Invalid target_event_id' });
      }
    }

    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO verification_actions (
           user_id,
           post_id,
           action_type,
           target_link_id,
           target_event_id
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [userId, postId, actionType, resolvedLinkId, targetEventId]
      );

      if ((actionType === 'confirm_market_match' || actionType === 'reject_market_match') && resolvedLinkId) {
        if (actionType === 'confirm_market_match') {
          await db.query(
            `UPDATE post_market_links
               SET confirmed_count = confirmed_count + 1,
                   updated_at = NOW()
             WHERE id = $1`,
            [resolvedLinkId]
          );
        } else {
          await db.query(
            `UPDATE post_market_links
               SET flagged_count = flagged_count + 1,
                   updated_at = NOW()
             WHERE id = $1`,
            [resolvedLinkId]
          );
        }
      }

      if (actionType === 'suggest_market') {
        await db.query(
          `INSERT INTO post_market_links (
             post_id,
             event_id,
             stance,
             source,
             match_confidence
           ) VALUES ($1, $2, 'related', 'reader_suggested', NULL)
           ON CONFLICT (post_id, event_id)
           DO UPDATE SET source = 'reader_suggested', updated_at = NOW()`,
          [postId, targetEventId]
        );
      }

      await db.query('COMMIT');
      res.status(200).json({
        success: true,
        action: actionType,
        post_id: postId,
        target_link_id: resolvedLinkId
      });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    const missingTableResponse = normalizeOptionalTableResult(error, res);
    if (missingTableResponse) {
      return missingTableResponse;
    }

    if (error.message.startsWith('Invalid ')) {
      return res.status(400).json({ message: error.message });
    }
    console.error('Error submitting verification:', error);
    res.status(500).json({ message: 'Failed to submit verification' });
  }
};
