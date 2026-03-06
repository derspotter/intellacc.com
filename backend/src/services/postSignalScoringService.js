/**
 * postSignalScoringService.js
 * 
 * Implements the Persuasive Alpha (Track A) settlement pipeline.
 * Computes marginal information value (scores) for attributed market updates
 * and mints rewards idempotently via PostgreSQL's SKIP LOCKED.
 */

const { getPool, executeWithTransaction } = require('../db');
const config = require('./persuasiveAlphaConfig');

const LOG_CTX = '[PersuasionScorer]';
const PREDICTION_ENGINE_BASE_URL = process.env.PREDICTION_ENGINE_BASE_URL || 'http://prediction-engine:3001';

const runPayerBatch = async (options = {}) => {
    const triggerType = typeof options.triggerType === 'string' && options.triggerType.trim()
        ? options.triggerType.trim()
        : 'manual';
    const ts_started = new Date();
    const runLog = {
        trigger_type: triggerType, // manual | admin | cron
        is_enabled: config.enabled,
        processed_updates: 0,
        attributed_updates: 0,
        episodes_created: 0,
        payout_rows_created: 0,
        minted_ledger_total: 0n,
        skipped_by_cap: 0,
        skipped_by_threshold: 0,
        claim_conflicts: 0,
        error_count: 0,
        events: []
    };

    const pool = getPool();

    if (!config.enabled) {
        console.log(`${LOG_CTX} Rewards disabled by POST_SIGNAL_REWARDS_ENABLED.`);
        runLog.events.push('SKIPPED_DISABLED');
        await writeRunLog(pool, ts_started, runLog);
        return runLog;
    }

    try {
        console.log(`${LOG_CTX} Starting batch run...`);

        // Step 1: Build episodes from raw market updates
        const buildRes = await buildEpisodes(pool);
        runLog.processed_updates += buildRes.processed_updates;
        runLog.attributed_updates += buildRes.attributed_updates;
        runLog.episodes_created += buildRes.episodes_created;
        runLog.skipped_by_threshold += buildRes.skipped_by_threshold;

        // Step 2: Score mature and final horizons in prediction-engine (single source of truth)
        const scoreRes = await scoreMatureEpisodes();
        if (scoreRes?.processed_episodes != null || scoreRes?.updated_components != null) {
            runLog.events.push(`ENGINE_SCORE processed=${scoreRes.processed_episodes || 0} updated=${scoreRes.updated_components || 0}`);
        }

        // Step 3: Mint Payouts Idempotently
        const mintRes = await executeWithTransaction(async (client) => {
            return await mintPayouts(client);
        });

        runLog.payout_rows_created += mintRes.payout_rows_created;
        runLog.minted_ledger_total = mintRes.minted_ledger_total;
        runLog.skipped_by_cap += mintRes.skipped_by_cap;

    } catch (error) {
        console.error(`${LOG_CTX} Error in batch run:`, error);
        runLog.error_count += 1;
        runLog.events.push(`ERROR: ${error.message}`);
    } finally {
        await writeRunLog(pool, ts_started, runLog);
        console.log(`${LOG_CTX} Batch run complete. Episodes: ${runLog.episodes_created}, Minted Ledger: ${runLog.minted_ledger_total}`);
    }

    return runLog;
};

const buildEpisodes = async (pool) => {
    const stats = { processed_updates: 0, attributed_updates: 0, episodes_created: 0, skipped_by_threshold: 0 };

    // Find market updates with referral_post_id that don't have an episode yet
    const res = await pool.query(`
    SELECT mu.id as market_update_id, mu.event_id, mu.user_id as trader_user_id, mu.created_at,
           mu.prev_prob AS market_prob_before, mu.new_prob AS market_prob_after, mu.stake_amount_ledger,
           mu.had_prior_position, mu.referral_post_id
    FROM market_updates mu
    LEFT JOIN post_signal_episodes pse ON pse.market_update_id = mu.id
    WHERE mu.referral_post_id IS NOT NULL 
      AND pse.id IS NULL
    ORDER BY mu.created_at ASC
    LIMIT 1000
  `);

    stats.processed_updates = res.rowCount;
    stats.attributed_updates = res.rowCount;

    for (const row of res.rows) {
        // Meaningful Threshold Check (Open Problem 4/5)
        // Needs to move at least minProbDelta OR stake >= minStakeLedger
        const delta = Math.abs(parseFloat(row.market_prob_after) - parseFloat(row.market_prob_before));
        const stakeLedger = BigInt(row.stake_amount_ledger || 0);

        if (delta < config.minProbDelta && stakeLedger < BigInt(config.minStakeLedger)) {
            stats.skipped_by_threshold++;
            // Still insert an empty episode so we don't process it again? Actually, just mark is_meaningful=false.
        }

        const isMeaningful = (delta >= config.minProbDelta || stakeLedger >= BigInt(config.minStakeLedger));
        const episodeType = row.had_prior_position ? 'belief' : 'attention';

        try {
            // 15-minute bucket starting from update's created_at (rounding down to nearest 15 mins)
            const bucketMs = 15 * 60 * 1000;
            const bucketStart = new Date(Math.floor(new Date(row.created_at).getTime() / bucketMs) * bucketMs);

            await pool.query(`
        INSERT INTO post_signal_episodes (
          market_update_id, post_id, event_id, trader_user_id, episode_bucket_start,
          episode_type, is_meaningful, p_before, p_after
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (market_update_id) DO NOTHING
      `, [
                row.market_update_id, row.referral_post_id, row.event_id, row.trader_user_id, bucketStart,
                episodeType, isMeaningful, row.market_prob_before, row.market_prob_after
            ]);
            stats.episodes_created++;
        } catch (e) {
            console.error(`${LOG_CTX} Error inserting episode for update ${row.market_update_id}:`, e);
        }
    }

    return stats;
};

const scoreMatureEpisodes = async () => {
    const token = process.env.PREDICTION_ENGINE_AUTH_TOKEN;
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['x-engine-token'] = token;
    }

    const response = await fetch(`${PREDICTION_ENGINE_BASE_URL}/persuasion/score-mature-episodes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({})
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Prediction-engine mature scoring failed (${response.status}): ${payload.error || 'unknown error'}`);
    }
    return payload;
};

const mintPayouts = async (client) => {
    const stats = { payout_rows_created: 0, minted_ledger_total: 0n, skipped_by_cap: 0 };

    // Find components ready for payout (finalized but no payout row exists). Lock to avoid concurrency.
    const res = await client.query(`
    SELECT pse.id as episode_id, pse.post_id, p.user_id as author_user_id, pse.event_id,
           pse.episode_type, pse.s_early, pse.s_mid, pse.s_final
    FROM post_signal_episodes pse
    JOIN posts p ON p.id = pse.post_id
    WHERE pse.is_meaningful = TRUE
      AND (
        (pse.s_early IS NOT NULL AND NOT EXISTS (SELECT 1 FROM post_signal_reward_payouts WHERE episode_id = pse.id AND component = 'early')) OR
        (pse.s_mid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM post_signal_reward_payouts WHERE episode_id = pse.id AND component = 'mid')) OR
        (pse.s_final IS NOT NULL AND NOT EXISTS (SELECT 1 FROM post_signal_reward_payouts WHERE episode_id = pse.id AND component = 'final'))
      )
    FOR UPDATE OF pse SKIP LOCKED
  `);

    for (const row of res.rows) {
        const components = [];
        if (row.s_early !== null) components.push({ type: 'early', score: parseFloat(row.s_early), weight: config.earlyWeight });
        if (row.s_mid !== null) components.push({ type: 'mid', score: parseFloat(row.s_mid), weight: config.midWeight });
        if (row.s_final !== null) components.push({ type: 'final', score: parseFloat(row.s_final), weight: config.finalWeight });

        for (const c of components) {
            // Check if payout row already exists for this component
            const checkRes = await client.query(`
        SELECT 1 FROM post_signal_reward_payouts 
        WHERE episode_id = $1 AND component = $2
      `, [row.episode_id, c.type]);

            if (checkRes.rowCount > 0) continue;

            const r_u = 1.0; // uniform reliability in v1
            const m_episode = row.episode_type === 'belief' ? config.beliefMultiplier : config.attentionMultiplier;

            const componentScore = r_u * m_episode * (c.weight * c.score);
            const rewardLedger = BigInt(Math.floor(componentScore * config.mintRateLedgerPerPoint));

            if (rewardLedger <= 0n) {
                // Zero reward, insert with 'skipped_by_cap' or 'zero_reward' to mark done
                await client.query(`
              INSERT INTO post_signal_reward_payouts (episode_id, post_id, author_user_id, event_id, component, score_component, mint_rate_snapshot, reward_ledger, payout_status)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'minted')
          `, [row.episode_id, row.post_id, row.author_user_id, row.event_id, c.type, componentScore, config.mintRateLedgerPerPoint, 0]);
                continue;
            }

            // Insert minted payout
            await client.query(`
        INSERT INTO post_signal_reward_payouts (episode_id, post_id, author_user_id, event_id, component, score_component, mint_rate_snapshot, reward_ledger, payout_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'minted')
      `, [row.episode_id, row.post_id, row.author_user_id, row.event_id, c.type, componentScore, config.mintRateLedgerPerPoint, rewardLedger]);

            // Update author RP balance
            await client.query(`UPDATE users SET rp_balance_ledger = rp_balance_ledger + $1 WHERE id = $2`, [rewardLedger, row.author_user_id]);

            stats.payout_rows_created++;
            stats.minted_ledger_total += rewardLedger;
        }

        // Update episode combined score just for reporting purposes (optional but nice)
        await client.query(`
      UPDATE post_signal_episodes 
      SET combined_score = COALESCE(
        (SELECT SUM(score_component) FROM post_signal_reward_payouts WHERE episode_id = $1), 0.0)
      WHERE id = $1
    `, [row.episode_id]);
    }

    return stats;
};

const writeRunLog = async (pool, ts_started, logData) => {
    const ts_finished = new Date();
    const duration_ms = ts_finished.getTime() - ts_started.getTime();
    const logJson = JSON.stringify(logData, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );

    // Convert BigInts to strings for raw Postgres logs if needed, but parameter expects simple types.
    const query = `
    INSERT INTO post_signal_run_logs (
      ts_started, ts_finished, duration_ms, trigger_type, is_enabled,
      processed_updates, attributed_updates, episodes_created, payout_rows_created, 
      minted_ledger_total, skipped_by_cap, skipped_by_threshold, claim_conflicts, error_count, run_log
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `;

    await pool.query(query, [
        ts_started, ts_finished, duration_ms, logData.trigger_type, logData.is_enabled,
        logData.processed_updates, logData.attributed_updates, logData.episodes_created, logData.payout_rows_created,
        logData.minted_ledger_total.toString(), logData.skipped_by_cap, logData.skipped_by_threshold,
        logData.claim_conflicts, logData.error_count, logJson
    ]);
};

module.exports = {
    runPayerBatch,
    buildEpisodes,
    scoreMatureEpisodes,
    mintPayouts
};
