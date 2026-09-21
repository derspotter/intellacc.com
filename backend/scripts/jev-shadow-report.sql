-- Read-only report of current post versions. Agreement is not accuracy.
BEGIN READ ONLY;
WITH current_jev_shadow AS (
SELECT s.* FROM post_match_jev_shadow s
JOIN post_analysis a ON a.post_id = s.post_id AND a.processing_run_id = s.processing_run_id
JOIN posts p ON p.id = s.post_id
WHERE s.content_hash = encode(sha256(convert_to(COALESCE(p.content, ''), 'UTF8')), 'hex')
)

SELECT status, result->>'error_code' AS error_code,
       result->>'error_field' AS error_field, COUNT(*) AS posts
FROM current_jev_shadow GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

WITH current_jev_shadow AS (
SELECT s.* FROM post_match_jev_shadow s
JOIN post_analysis a ON a.post_id = s.post_id AND a.processing_run_id = s.processing_run_id
JOIN posts p ON p.id = s.post_id
WHERE s.content_hash = encode(sha256(convert_to(COALESCE(p.content, ''), 'UTF8')), 'hex')
)
SELECT result->>'used_model' AS model, result->>'prompt_version' AS prompt_version,
       COUNT(*) AS successful_posts,
       ROUND(AVG((result->>'latency_ms')::numeric)) AS mean_latency_ms,
       ROUND(AVG((baseline->>'gate_latency_ms')::numeric)) AS baseline_mean_gate_ms,
       ROUND(AVG((baseline->>'reason_latency_ms')::numeric)) AS baseline_mean_reason_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY (result->>'latency_ms')::numeric) AS p95_latency_ms,
       SUM((result->>'input_tokens')::bigint) AS known_input_tokens,
       COUNT(*) FILTER (WHERE result->>'input_tokens' IS NULL) AS missing_usage_posts,
       SUM((result->>'cost_usd')::numeric) AS reported_cost_usd,
       COUNT(*) FILTER (WHERE result->>'cost_usd' IS NULL) AS missing_cost_posts,
       ROUND(SUM((result->>'input_tokens')::numeric) * 0.042 / 1000000, 6) AS estimated_input_usd
FROM current_jev_shadow WHERE status = 'ok' GROUP BY 1, 2;

WITH current_jev_shadow AS (
SELECT s.* FROM post_match_jev_shadow s
JOIN post_analysis a ON a.post_id = s.post_id AND a.processing_run_id = s.processing_run_id
JOIN posts p ON p.id = s.post_id
WHERE s.content_hash = encode(sha256(convert_to(COALESCE(p.content, ''), 'UTF8')), 'hex')
)
SELECT post_id, baseline->>'has_claim' AS baseline_claim,
       result #>> '{answers,has_claim,noul}' AS jev_claim_probability,
       baseline->>'proposed_event_id' AS baseline_event,
       result #>> '{answers,best_market,choice}' AS jev_choice,
       result #>> '{answers,best_market,confidence}' AS jev_confidence,
       baseline->>'persisted_match' AS baseline_persisted_match
FROM current_jev_shadow
WHERE status = 'ok' AND (baseline->>'processing_error')::boolean = FALSE
ORDER BY created_at DESC LIMIT 100;
ROLLBACK;
