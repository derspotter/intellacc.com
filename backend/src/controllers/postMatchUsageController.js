const db = require('../db');

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeTotals = (row = {}) => ({
  api_call_count: toInt(row.api_call_count, 0),
  api_success_count: toInt(row.api_success_count, 0),
  api_failure_count: toInt(row.api_failure_count, 0),
  prompt_tokens: toInt(row.prompt_tokens, 0),
  completion_tokens: toInt(row.completion_tokens, 0),
  total_tokens: toInt(row.total_tokens, 0),
  reasoning_tokens: toInt(row.reasoning_tokens, 0),
  cached_tokens: toInt(row.cached_tokens, 0),
  cost_credits: toNumber(row.cost_credits, 0)
});

exports.getSummary = async (req, res) => {
  const windowDays = clamp(toInt(req.query.days, 7), 1, 90);
  const listLimit = clamp(toInt(req.query.limit, 10), 1, 50);

  try {
    const [totalsResult, stageResult, modelResult, postResult, failureResult] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*) AS api_call_count,
           COUNT(*) FILTER (WHERE success) AS api_success_count,
           COUNT(*) FILTER (WHERE NOT success) AS api_failure_count,
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
           COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
           COALESCE(SUM(cost_credits), 0) AS cost_credits
         FROM post_match_api_usage
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
        [windowDays]
      ),
      db.query(
        `SELECT
           stage,
           operation,
           COUNT(*) AS api_call_count,
           COUNT(*) FILTER (WHERE success) AS api_success_count,
           COUNT(*) FILTER (WHERE NOT success) AS api_failure_count,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(cost_credits), 0) AS cost_credits
         FROM post_match_api_usage
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY stage, operation
        ORDER BY cost_credits DESC, api_call_count DESC, stage ASC`,
        [windowDays]
      ),
      db.query(
        `SELECT
           COALESCE(used_model, requested_model, 'unknown') AS model,
           COUNT(*) AS api_call_count,
           COUNT(*) FILTER (WHERE success) AS api_success_count,
           COUNT(*) FILTER (WHERE NOT success) AS api_failure_count,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(cost_credits), 0) AS cost_credits
         FROM post_match_api_usage
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY COALESCE(used_model, requested_model, 'unknown')
        ORDER BY cost_credits DESC, api_call_count DESC, model ASC
        LIMIT $2`,
        [windowDays, listLimit]
      ),
      db.query(
        `SELECT
           pmu.post_id,
           u.username,
           LEFT(p.content, 160) AS preview,
           COUNT(*) AS api_call_count,
           COUNT(*) FILTER (WHERE pmu.success) AS api_success_count,
           COUNT(*) FILTER (WHERE NOT pmu.success) AS api_failure_count,
           COALESCE(SUM(pmu.total_tokens), 0) AS total_tokens,
           COALESCE(SUM(pmu.cost_credits), 0) AS cost_credits,
           MAX(pmu.created_at) AS last_call_at
         FROM post_match_api_usage pmu
         JOIN posts p ON p.id = pmu.post_id
         JOIN users u ON u.id = p.user_id
        WHERE pmu.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY pmu.post_id, u.username, p.content
        ORDER BY cost_credits DESC, last_call_at DESC
        LIMIT $2`,
        [windowDays, listLimit]
      ),
      db.query(
        `SELECT
           post_id,
           stage,
           operation,
           COALESCE(used_model, requested_model, 'unknown') AS model,
           error_message,
           created_at
         FROM post_match_api_usage
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND success = FALSE
        ORDER BY created_at DESC
        LIMIT $2`,
        [windowDays, listLimit]
      )
    ]);

    res.json({
      window_days: windowDays,
      totals: normalizeTotals(totalsResult.rows[0]),
      by_stage: stageResult.rows.map((row) => ({
        stage: row.stage,
        operation: row.operation,
        ...normalizeTotals(row)
      })),
      by_model: modelResult.rows.map((row) => ({
        model: row.model,
        ...normalizeTotals(row)
      })),
      top_posts: postResult.rows.map((row) => ({
        post_id: toInt(row.post_id, 0),
        username: row.username,
        preview: row.preview,
        last_call_at: row.last_call_at,
        ...normalizeTotals(row)
      })),
      recent_failures: failureResult.rows.map((row) => ({
        post_id: toInt(row.post_id, 0),
        stage: row.stage,
        operation: row.operation,
        model: row.model,
        error_message: row.error_message,
        created_at: row.created_at
      }))
    });
  } catch (error) {
    if (error?.code === '42P01') {
      return res.status(200).json({
        window_days: windowDays,
        totals: normalizeTotals(),
        by_stage: [],
        by_model: [],
        top_posts: [],
        recent_failures: []
      });
    }

    console.error('Error loading post match usage summary:', error);
    return res.status(500).json({ message: 'Failed to load post match usage summary' });
  }
};
