const db = require('../db');

const LEDGER_DIVISOR = 1000000.0;

exports.getMyPredictionDashboard = async (req, res) => {
  const userId = req.user?.id ?? req.user?.userId;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const [summaryResult, activityResult, recentPredictionsResult, openPositionsResult] = await Promise.all([
      db.query(
        `
          SELECT
            COUNT(*)::INT AS total_predictions,
            COUNT(*) FILTER (WHERE outcome IS NULL)::INT AS pending_predictions,
            COUNT(*) FILTER (WHERE outcome IS NOT NULL)::INT AS resolved_predictions,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(outcome, '')) = 'correct')::INT AS correct_predictions,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(outcome, '')) = 'incorrect')::INT AS incorrect_predictions,
            ROUND(COALESCE(AVG(confidence), 0)::NUMERIC, 2)::DOUBLE PRECISION AS average_confidence,
            CASE
              WHEN COUNT(*) FILTER (WHERE outcome IS NOT NULL) = 0 THEN NULL
              ELSE ROUND(
                (
                  100.0 * COUNT(*) FILTER (WHERE LOWER(COALESCE(outcome, '')) = 'correct')
                  / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0)
                )::NUMERIC,
                2
              )::DOUBLE PRECISION
            END AS accuracy_percent
          FROM predictions
          WHERE user_id = $1
        `,
        [userId]
      ),
      db.query(
        `
          WITH binary_trades AS (
            SELECT
              COUNT(*)::INT AS trade_count,
              COALESCE(SUM(stake_amount_ledger), 0)::BIGINT AS staked_ledger
            FROM market_updates
            WHERE user_id = $1
              AND created_at >= NOW() - INTERVAL '30 days'
          ),
          outcome_trades AS (
            SELECT
              COUNT(*)::INT AS trade_count,
              COALESCE(SUM(stake_amount_ledger), 0)::BIGINT AS staked_ledger
            FROM market_outcome_updates
            WHERE user_id = $1
              AND created_at >= NOW() - INTERVAL '30 days'
          ),
          open_binary AS (
            SELECT
              COUNT(*)::INT AS position_count,
              COUNT(DISTINCT event_id)::INT AS market_count
            FROM user_shares
            WHERE user_id = $1
              AND (yes_shares > 0 OR no_shares > 0)
          ),
          open_outcomes AS (
            SELECT
              COUNT(*)::INT AS position_count,
              COUNT(DISTINCT event_id)::INT AS market_count
            FROM user_outcome_shares
            WHERE user_id = $1
              AND shares > 0
          ),
          user_ledger AS (
            SELECT
              (COALESCE(rp_balance_ledger, 0)::DOUBLE PRECISION / ${LEDGER_DIVISOR}) AS available_reputation,
              (COALESCE(rp_staked_ledger, 0)::DOUBLE PRECISION / ${LEDGER_DIVISOR}) AS staked_reputation,
              ((COALESCE(rp_balance_ledger, 0) + COALESCE(rp_staked_ledger, 0))::DOUBLE PRECISION / ${LEDGER_DIVISOR}) AS total_reputation
            FROM users
            WHERE id = $1
          )
          SELECT
            (SELECT available_reputation FROM user_ledger) AS available_reputation,
            (SELECT staked_reputation FROM user_ledger) AS staked_reputation,
            (SELECT total_reputation FROM user_ledger) AS total_reputation,
            ((SELECT trade_count FROM binary_trades) + (SELECT trade_count FROM outcome_trades))::INT AS trades_last_30d,
            (((SELECT staked_ledger FROM binary_trades) + (SELECT staked_ledger FROM outcome_trades))::DOUBLE PRECISION / ${LEDGER_DIVISOR}) AS staked_last_30d,
            ((SELECT position_count FROM open_binary) + (SELECT position_count FROM open_outcomes))::INT AS open_positions,
            ((SELECT market_count FROM open_binary) + (SELECT market_count FROM open_outcomes))::INT AS active_markets
        `,
        [userId]
      ),
      db.query(
        `
          SELECT
            p.id,
            p.event_id,
            p.event,
            p.prediction_value,
            p.confidence,
            p.prediction_type,
            p.outcome,
            p.created_at,
            e.event_type,
            e.closing_date,
            e.outcome AS event_resolution,
            e.numerical_outcome
          FROM predictions p
          LEFT JOIN events e ON e.id = p.event_id
          WHERE p.user_id = $1
          ORDER BY p.created_at DESC
          LIMIT 8
        `,
        [userId]
      ),
      db.query(
        `
          WITH binary_positions AS (
            SELECT
              us.event_id,
              e.title AS event_title,
              'binary'::TEXT AS position_type,
              CASE
                WHEN us.yes_shares > 0 AND us.no_shares > 0 THEN 'YES / NO'
                WHEN us.yes_shares > 0 THEN 'YES'
                ELSE 'NO'
              END AS exposure_label,
              TRIM(BOTH ' ' FROM CONCAT(
                CASE WHEN us.yes_shares > 0 THEN CONCAT('YES ', ROUND(us.yes_shares::NUMERIC, 2)) ELSE '' END,
                CASE WHEN us.yes_shares > 0 AND us.no_shares > 0 THEN ' · ' ELSE '' END,
                CASE WHEN us.no_shares > 0 THEN CONCAT('NO ', ROUND(us.no_shares::NUMERIC, 2)) ELSE '' END
              )) AS quantity_label,
              (COALESCE(us.total_staked_ledger, 0)::DOUBLE PRECISION / ${LEDGER_DIVISOR}) AS staked_rp,
              e.closing_date,
              e.market_prob,
              us.last_updated AS updated_at
            FROM user_shares us
            JOIN events e ON e.id = us.event_id
            WHERE us.user_id = $1
              AND (us.yes_shares > 0 OR us.no_shares > 0)
          ),
          outcome_positions AS (
            SELECT
              uos.event_id,
              e.title AS event_title,
              COALESCE(e.event_type, 'outcome')::TEXT AS position_type,
              eo.label AS exposure_label,
              CONCAT(ROUND(uos.shares::NUMERIC, 2), ' shares') AS quantity_label,
              (COALESCE(uos.staked_ledger, 0)::DOUBLE PRECISION / ${LEDGER_DIVISOR}) AS staked_rp,
              e.closing_date,
              eos.prob AS market_prob,
              uos.updated_at
            FROM user_outcome_shares uos
            JOIN events e ON e.id = uos.event_id
            LEFT JOIN event_outcomes eo ON eo.id = uos.outcome_id
            LEFT JOIN event_outcome_states eos ON eos.event_id = uos.event_id AND eos.outcome_id = uos.outcome_id
            WHERE uos.user_id = $1
              AND uos.shares > 0
          )
          SELECT
            event_id,
            event_title,
            position_type,
            exposure_label,
            quantity_label,
            staked_rp,
            closing_date,
            market_prob,
            updated_at
          FROM (
            SELECT * FROM binary_positions
            UNION ALL
            SELECT * FROM outcome_positions
          ) positions
          ORDER BY updated_at DESC
          LIMIT 8
        `,
        [userId]
      )
    ]);

    return res.json({
      summary: summaryResult.rows[0] || {
        total_predictions: 0,
        pending_predictions: 0,
        resolved_predictions: 0,
        correct_predictions: 0,
        incorrect_predictions: 0,
        average_confidence: 0,
        accuracy_percent: null
      },
      activity: activityResult.rows[0] || {
        available_reputation: 0,
        staked_reputation: 0,
        total_reputation: 0,
        trades_last_30d: 0,
        staked_last_30d: 0,
        open_positions: 0,
        active_markets: 0
      },
      recent_predictions: recentPredictionsResult.rows || [],
      open_positions: openPositionsResult.rows || []
    });
  } catch (error) {
    console.error('Error fetching prediction analytics dashboard:', error);
    return res.status(500).json({ message: 'Failed to fetch prediction analytics dashboard' });
  }
};
