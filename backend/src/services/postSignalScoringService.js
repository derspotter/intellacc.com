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

const runPayerBatch = async () => {
    const ts_started = new Date();
    const runLog = {
        trigger_type: 'manual', // or cron
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

        // Step 2: Score mature and final horizons
        await scoreMatureEpisodes(pool);

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
           mu.market_prob_before, mu.market_prob_after, mu.stake_amount_ledger,
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

const getInterpolatedProbAtTime = async (pool, eventId, targetTimestamp, fallbackProb) => {
    // Returns closest market prob AFTER the target time or BEFORE the target time.
    const res = await pool.query(`
    SELECT market_prob_after 
    FROM market_updates 
    WHERE event_id = $1 AND created_at <= $2 
    ORDER BY created_at DESC 
    LIMIT 1
  `, [eventId, targetTimestamp]);

    if (res.rowCount > 0) {
        return parseFloat(res.rows[0].market_prob_after);
    }

    return fallbackProb;
};

const scoreMatureEpisodes = async (pool) => {
    // 1. Find unresolved episodes that are meaningful
    const res = await pool.query(`
    SELECT pse.id, pse.event_id, pse.p_before, pse.p_after, 
           pse.s_early, pse.s_mid, pse.s_final,
           e.created_at as event_start, e.closing_date, e.outcome, e.market_prob as current_prob
    FROM post_signal_episodes pse
    JOIN events e ON e.id = pse.event_id
    WHERE pse.is_meaningful = TRUE 
      AND (pse.s_early IS NULL OR pse.s_mid IS NULL OR (pse.s_final IS NULL AND e.outcome IS NOT NULL))
  `);

    for (const row of res.rows) {
        const tsStart = new Date(row.event_start).getTime();
        const tsClose = new Date(row.closing_date).getTime();
        const tsNow = Date.now();
        const remaining = Math.max(0, tsClose - tsStart);

        const earlyTime = new Date(tsStart + config.firstHorizonFraction * remaining);
        const midTime = new Date(tsStart + config.secondHorizonFraction * remaining);

        let earlyScore = null, midScore = null, finalScore = null;
        let s_early_finalized = false;
        let s_mid_finalized = false;
        let s_final_finalized = false;

        // Helper log-loss delta: logloss(target, p_before) - logloss(target, p_after)
        // Proper-score delta: S_h = max(0, Delta_h)
        const computeScore = (target, pBefore, pAfter) => {
            // Simplified log loss calculation or Brier score. Using Brier score delta for simplicity & bounded rewards.
            // BrierScore = (p - target)^2
            // BrierDelta = Brier(pBefore, target) - Brier(pAfter, target)
            // If BrierDelta > 0, the prediction moved closer to the target.
            const brierBefore = Math.pow(pBefore - target, 2);
            const brierAfter = Math.pow(pAfter - target, 2);
            return Math.max(0, brierBefore - brierAfter);
        };

        if (row.s_early === null && tsNow > earlyTime.getTime()) {
            const targetEarly = await getInterpolatedProbAtTime(pool, row.event_id, earlyTime, row.current_prob);
            earlyScore = computeScore(targetEarly, row.p_before, row.p_after);
            s_early_finalized = true;
        }

        if (row.s_mid === null && tsNow > midTime.getTime()) {
            const targetMid = await getInterpolatedProbAtTime(pool, row.event_id, midTime, row.current_prob);
            midScore = computeScore(targetMid, row.p_before, row.p_after);
            s_mid_finalized = true;
        }

        if (row.s_final === null && row.outcome !== null) {
            // Event resolved, outcome is true (1) or false (0)
            const targetFinal = row.outcome ? 1.0 : 0.0;
            finalScore = computeScore(targetFinal, row.p_before, row.p_after);
            s_final_finalized = true;
        }

        if (s_early_finalized || s_mid_finalized || s_final_finalized) {
            const updates = [];
            const values = [];
            let counter = 1;
            if (s_early_finalized) {
                updates.push(`s_early = $${counter++}`, `finalized_early_at = NOW()`);
                values.push(earlyScore);
            }
            if (s_mid_finalized) {
                updates.push(`s_mid = $${counter++}`, `finalized_mid_at = NOW()`);
                values.push(midScore);
            }
            if (s_final_finalized) {
                updates.push(`s_final = $${counter++}`, `finalized_final_at = NOW()`);
                values.push(finalScore);
            }
            values.push(row.id);

            // Re-calculate combined score (S_episode)
            // Note: we'd compute combined score properly once all parts are filled, but wait until payout stage.

            await pool.query(`UPDATE post_signal_episodes SET ${updates.join(', ')} WHERE id = $${counter}`, values);
        }
    }
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

            // CAP CHECKS
            // 1. Post daily cap
            const postDailyRes = await client.query(`
        SELECT SUM(reward_ledger) as tot FROM post_signal_reward_payouts 
        WHERE post_id = $1 AND created_at >= NOW() - INTERVAL '1 day' AND payout_status = 'minted'
      `, [row.post_id]);
            const postDailyUsed = BigInt(postDailyRes.rows[0].tot || 0);

            // 2. Author daily cap
            const authorDailyRes = await client.query(`
        SELECT SUM(reward_ledger) as tot FROM post_signal_reward_payouts 
        WHERE author_user_id = $1 AND created_at >= NOW() - INTERVAL '1 day' AND payout_status = 'minted'
      `, [row.author_user_id]);
            const authorDailyUsed = BigInt(authorDailyRes.rows[0].tot || 0);

            const postCapRemain = BigInt(config.capPerPostPerDayLedger) - postDailyUsed;
            const authorCapRemain = BigInt(config.capPerAuthorPerDayLedger) - authorDailyUsed;

            if (postCapRemain <= 0n || authorCapRemain <= 0n) {
                stats.skipped_by_cap++;
                await client.query(`
          INSERT INTO post_signal_reward_payouts (episode_id, post_id, author_user_id, event_id, component, score_component, mint_rate_snapshot, reward_ledger, payout_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'skipped_by_cap')
        `, [row.episode_id, row.post_id, row.author_user_id, row.event_id, c.type, componentScore, config.mintRateLedgerPerPoint, rewardLedger]);
                continue;
            }

            // Safe mint amount
            let mintAmount = rewardLedger;
            if (mintAmount > postCapRemain) mintAmount = postCapRemain;
            if (mintAmount > authorCapRemain) mintAmount = authorCapRemain;

            // Insert minted payout
            await client.query(`
        INSERT INTO post_signal_reward_payouts (episode_id, post_id, author_user_id, event_id, component, score_component, mint_rate_snapshot, reward_ledger, payout_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'minted')
      `, [row.episode_id, row.post_id, row.author_user_id, row.event_id, c.type, componentScore, config.mintRateLedgerPerPoint, mintAmount]);

            // Update author RP balance
            await client.query(`UPDATE users SET rp_balance_ledger = rp_balance_ledger + $1 WHERE id = $2`, [mintAmount, row.author_user_id]);

            stats.payout_rows_created++;
            stats.minted_ledger_total += mintAmount;
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
    const logJson = JSON.stringify(logData);

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
