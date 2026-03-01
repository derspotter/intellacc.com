const postSignalScoringService = require('../src/services/postSignalScoringService');
const config = require('../src/services/persuasiveAlphaConfig');

describe('postSignalScoringService', () => {

    const buildQueryMock = (queryLog) => {
        return async (sql, params = []) => {
            queryLog.push({ sql: String(sql).trim().replace(/\s+/g, ' '), params });

            // Mock fetching market_updates for episode builder
            if (sql.includes('SELECT mu.id as market_update_id')) {
                return {
                    rowCount: 2,
                    rows: [
                        {
                            market_update_id: 101,
                            event_id: 201,
                            trader_user_id: 1,
                            created_at: new Date('2026-03-20T10:05:00Z'),
                            market_prob_before: '0.40',
                            market_prob_after: '0.45',
                            stake_amount_ledger: String(1 * 1_000_000), // 1 RP
                            had_prior_position: false,
                            referral_post_id: 301
                        },
                        { // Dust update (skipped by threshold)
                            market_update_id: 102,
                            event_id: 201,
                            trader_user_id: 1,
                            created_at: new Date('2026-03-20T10:10:00Z'),
                            market_prob_before: '0.45',
                            market_prob_after: '0.455', // < 0.01 delta
                            stake_amount_ledger: String(500_000), // < 1 RP
                            had_prior_position: true,
                            referral_post_id: 301
                        }
                    ]
                };
            }

            // Mock fetching mature horizons
            if (sql.includes('SELECT pse.id, pse.event_id, pse.p_before, pse.p_after')) {
                // We simulate a mature episode exactly at closing 
                return {
                    rows: [
                        {
                            id: 1,
                            event_id: 201,
                            p_before: '0.40',
                            p_after: '0.45',
                            s_early: null,
                            s_mid: null,
                            s_final: null,
                            event_start: new Date(Date.now() - 10000000),
                            closing_date: new Date(Date.now() - 1000),
                            outcome: true,
                            current_prob: '1.0'
                        },
                        {
                            // This episode moved in the wrong direction -> zero floor
                            id: 2,
                            event_id: 201,
                            p_before: '0.80',
                            p_after: '0.60', // drifted away from 1.0
                            s_early: null,
                            s_mid: null,
                            s_final: null,
                            event_start: new Date(Date.now() - 10000000),
                            closing_date: new Date(Date.now() - 1000),
                            outcome: true,
                            current_prob: '1.0'
                        }
                    ]
                };
            }

            // Mock historical interpolator
            if (sql.includes('SELECT market_prob_after') && sql.includes('FROM market_updates')) {
                return { rowCount: 1, rows: [{ market_prob_after: '1.0' }] };
            }

            // Mock fetching components to mint
            if (sql.includes('SELECT pse.id as episode_id, pse.post_id')) {
                return {
                    rows: [
                        {
                            episode_id: 1,
                            post_id: 301,
                            author_user_id: 5,
                            event_id: 201,
                            episode_type: 'attention',
                            s_early: '0.1', // (0.4-0.6)^2 - (0.45-0.6)^2 = 0.04 - 0.0225 = ~0.0175
                            s_mid: '0.1',
                            s_final: '0.1'
                        }
                    ]
                };
            }

            // Mock checking existing payout rows
            if (sql.includes('SELECT 1 FROM post_signal_reward_payouts WHERE episode_id = $1 AND component = $2')) {
                return { rowCount: 0 }; // Not minted yet
            }

            // Mock daily caps
            if (sql.includes('SUM(reward_ledger)') && sql.includes('post_id')) {
                // Simulated post has minted 0 so far
                return { rows: [{ tot: '0' }] };
            }
            if (sql.includes('SUM(reward_ledger)') && sql.includes('author_user_id')) {
                // Simulated author has minted 0 so far
                return { rows: [{ tot: '0' }] };
            }

            return { rowCount: 0, rows: [] };
        };
    };

    const poolMock = (queryLog) => ({
        query: buildQueryMock(queryLog),
        connect: async () => ({
            query: buildQueryMock(queryLog),
            release: jest.fn()
        })
    });

    beforeAll(() => {
        config.enabled = true; // force enabled for tests
    });

    it('buildEpisodes properly classifies limits and thresholds', async () => {
        const queryLog = [];
        const pool = poolMock(queryLog);
        const stats = await postSignalScoringService.buildEpisodes(pool);

        expect(stats.processed_updates).toBe(2);
        expect(stats.episodes_created).toBe(2); // Wait, one is not meaningful, but we still create the row to track assignment
        expect(stats.skipped_by_threshold).toBe(1);

        const importantInserts = queryLog.filter(q => q.sql.includes('INSERT INTO post_signal_episodes'));
        expect(importantInserts.length).toBe(2);

        // Check first (meaningful attention)
        expect(importantInserts[0].params[5]).toBe('attention'); // episode_type
        expect(importantInserts[0].params[6]).toBe(true); // is_meaningful

        // Check second (dust, belief)
        expect(importantInserts[1].params[5]).toBe('belief'); // episode_type
        expect(importantInserts[1].params[6]).toBe(false); // is_meaningful
    });

    it('scoreMatureEpisodes computes zero-floor rewards (negative becomes 0)', async () => {
        const queryLog = [];
        const pool = poolMock(queryLog);

        await postSignalScoringService.scoreMatureEpisodes(pool);
        // 2 mature episodes returned from our mock, 3 horizons each = 6 update statements

        const updates = queryLog.filter(q => q.sql.includes('UPDATE post_signal_episodes SET s_early'));
        expect(updates.length).toBe(2);

        // Look at episode 2 (wrong direction, zero floor)
        // Outcome = 1.0, p_before = 0.8, p_after = 0.6.
        // Base Brier: (0.8-1)^2 - (0.6-1)^2 = 0.04 - 0.16 = -0.12.
        // Zero floor Math.max(0, -0.12) = 0.
        const ep2Update = updates.find(q => q.params.includes(2)); // Row ID 2
        expect(ep2Update.params[0]).toBe(0); // early
        expect(ep2Update.params[1]).toBe(0); // mid
        expect(ep2Update.params[2]).toBe(0); // final
    });

    it('mintPayouts respects caps and writes idempotently', async () => {
        const queryLog = [];
        const pool = await poolMock(queryLog).connect();

        const stats = await postSignalScoringService.mintPayouts(pool);

        // The mock returns 1 episode ready for payout, with 3 components (early, mid, final)
        expect(stats.payout_rows_created).toBe(3);

        const inserts = queryLog.filter(q => q.sql.includes('INSERT INTO post_signal_reward_payouts'));
        expect(inserts.length).toBe(3);

        const authorBalanceUpdates = queryLog.filter(q => q.sql.includes('UPDATE users SET rp_balance_ledger = rp_balance_ledger'));
        expect(authorBalanceUpdates.length).toBe(3);

        expect(stats.skipped_by_cap).toBe(0);
    });
});
