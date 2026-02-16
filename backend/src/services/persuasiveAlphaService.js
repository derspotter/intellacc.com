const IN_PROGRESS_MARKER = 0;

const claimReferralClick = async ({ dbClient, userId, eventId }) => {
  const result = await dbClient.query(
    `WITH ranked_clicks AS (
       SELECT pmc.id, pmc.post_id
       FROM post_market_clicks pmc
       JOIN posts p ON p.id = pmc.post_id
       WHERE pmc.user_id = $1
         AND pmc.event_id = $2
         AND pmc.consumed_by_market_update_id IS NULL
         AND pmc.expires_at > NOW()
         AND p.user_id <> $1
       ORDER BY pmc.clicked_at DESC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE post_market_clicks pmc
     SET consumed_by_market_update_id = $3
     FROM ranked_clicks rc
     WHERE pmc.id = rc.id
     RETURNING rc.id AS click_id, rc.post_id`,
    [userId, eventId, IN_PROGRESS_MARKER]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    clickId: Number(result.rows[0].click_id),
    postId: Number(result.rows[0].post_id),
  };
};

const finalizeReferralClick = async ({ dbClient, clickId, marketUpdateId }) => {
  const result = await dbClient.query(
    `UPDATE post_market_clicks
     SET consumed_by_market_update_id = $2,
         consumed_at = NOW()
     WHERE id = $1
       AND consumed_by_market_update_id = 0
     RETURNING id`,
    [clickId, marketUpdateId]
  );

  return result.rows.length > 0;
};

const releaseReferralClick = async ({ dbClient, clickId }) => {
  const result = await dbClient.query(
    `UPDATE post_market_clicks
     SET consumed_by_market_update_id = NULL
     WHERE id = $1
       AND consumed_by_market_update_id = 0
     RETURNING id`,
    [clickId]
  );

  return result.rows.length > 0;
};

module.exports = {
  claimReferralClick,
  finalizeReferralClick,
  releaseReferralClick,
};
