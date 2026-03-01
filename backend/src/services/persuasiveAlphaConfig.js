/**
 * persuasiveAlphaConfig.js
 * Centralized configuration for the Persuasive Alpha (Track A) reward pipeline.
 * All ledger units explicitly documented per Open Problem 4 in the implementation plan.
 */

// 1 RP = 1,000,000 ledger units
const RP_MULTIPLIER = 1_000_000;

const parseEnvInt = (key, defaultVal) => {
    if (process.env[key] !== undefined) {
        const val = parseInt(process.env[key], 10);
        if (!isNaN(val)) return val;
    }
    return defaultVal;
};

const parseEnvFloat = (key, defaultVal) => {
    if (process.env[key] !== undefined) {
        const val = parseFloat(process.env[key]);
        if (!isNaN(val)) return val;
    }
    return defaultVal;
};

const parseEnvBool = (key, defaultVal) => {
    if (process.env[key] !== undefined) {
        return process.env[key] === 'true' || process.env[key] === '1';
    }
    return defaultVal;
};

module.exports = {
    // Master kill switch. Must be true to mint rewards.
    enabled: parseEnvBool('POST_SIGNAL_REWARDS_ENABLED', false),

    // 15-minute bucket for episode deduplication
    episodeWindowMinutes: parseEnvInt('POST_SIGNAL_EPISODE_WINDOW_MIN', 15),

    // Meaningful update thresholds
    minProbDelta: parseEnvFloat('POST_SIGNAL_MIN_PROB_DELTA', 0.01),
    minStakeLedger: parseEnvInt('POST_SIGNAL_MIN_STAKE_LEDGER', 1 * RP_MULTIPLIER), // Default: 1 RP

    // Episode type multipliers
    beliefMultiplier: parseEnvFloat('POST_SIGNAL_BELIEF_MULTIPLIER', 1.0),
    attentionMultiplier: parseEnvFloat('POST_SIGNAL_ATTENTION_MULTIPLIER', 0.35),

    // Horizon fractions
    firstHorizonFraction: parseEnvFloat('POST_SIGNAL_FIRST_HORIZON_FRACTION', 0.10),
    secondHorizonFraction: parseEnvFloat('POST_SIGNAL_SECOND_HORIZON_FRACTION', 0.50),

    // Horizon score weights
    earlyWeight: 0.2, // 20%
    midWeight: 0.3,   // 30%
    finalWeight: 0.5, // 50%

    // Fallback for market snapshots: use the event's current market_prob if historical is missing
    marketSnapshotFallback: process.env.POST_SIGNAL_MARKET_SNAPSHOT_FALLBACK || 'events.market_prob',

    // Payout Minting
    // Default: 1 point = 1 RP (1,000,000 ledger)
    mintRateLedgerPerPoint: parseEnvInt('POST_SIGNAL_MINT_RATE_LEDGER_PER_POINT', 1 * RP_MULTIPLIER),

    // Caps (all in Ledger units)
    // Default max per post/day: 100 RP
    capPerPostPerDayLedger: parseEnvInt('POST_SIGNAL_CAP_PER_POST_PER_DAY_LEDGER', 100 * RP_MULTIPLIER),

    // Default max per author/day: 500 RP
    capPerAuthorPerDayLedger: parseEnvInt('POST_SIGNAL_CAP_PER_AUTHOR_PER_DAY_LEDGER', 500 * RP_MULTIPLIER),

    // Default global max system mint per day: 10,000 RP
    capGlobalPerDayLedger: parseEnvInt('POST_SIGNAL_CAP_GLOBAL_PER_DAY_LEDGER', 10000 * RP_MULTIPLIER),
};
