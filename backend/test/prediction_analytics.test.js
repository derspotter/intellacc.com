const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  const userRow = await db.query('SELECT id FROM users WHERE email = $1', [email]);

  return {
    id: userRow.rows[0].id,
    email,
    username,
    password,
    token: loginRes.body.token
  };
};

describe('Prediction analytics dashboard', () => {
  const cleanup = {
    userIds: [],
    eventIds: []
  };

  afterAll(async () => {
    if (cleanup.eventIds.length > 0) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('returns summary, recent predictions, and open positions for the current user', async () => {
    const user = await createUser('analyticsuser');
    cleanup.userIds.push(user.id);

    await db.query(
      'UPDATE users SET rp_balance_ledger = $1, rp_staked_ledger = $2 WHERE id = $3',
      [920000000, 80000000, user.id]
    );

    const eventOne = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake)
       VALUES ($1, $2, NOW() + INTERVAL '10 days', 'binary', 0.62, 125.0)
       RETURNING id`,
      ['Will inflation fall by Q4?', 'Macro event']
    );
    const eventTwo = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake, outcome)
       VALUES ($1, $2, NOW() + INTERVAL '20 days', 'binary', 0.41, 95.0, 'yes')
       RETURNING id`,
      ['Will rates be cut?', 'Rates event']
    );
    const eventThree = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake, outcome)
       VALUES ($1, $2, NOW() + INTERVAL '30 days', 'binary', 0.55, 110.0, 'no')
       RETURNING id`,
      ['Will unemployment rise?', 'Labor event']
    );
    cleanup.eventIds.push(eventOne.rows[0].id, eventTwo.rows[0].id, eventThree.rows[0].id);

    await db.query(
      `INSERT INTO predictions
       (user_id, event_id, event, prediction_value, confidence, prediction_type, outcome, created_at)
       VALUES
       ($1, $2, $3, 'yes', 78, 'binary', NULL, NOW() - INTERVAL '1 day'),
       ($1, $4, $5, 'no', 64, 'binary', 'correct', NOW() - INTERVAL '2 days'),
       ($1, $6, $7, 'yes', 55, 'binary', 'incorrect', NOW() - INTERVAL '3 days')`,
      [
        user.id,
        eventOne.rows[0].id,
        'Will inflation fall by Q4?',
        eventTwo.rows[0].id,
        'Will rates be cut?',
        eventThree.rows[0].id,
        'Will unemployment rise?'
      ]
    );

    await db.query(
      `INSERT INTO user_shares
       (user_id, event_id, yes_shares, no_shares, total_staked_ledger, staked_yes_ledger, staked_no_ledger, last_updated)
       VALUES ($1, $2, 12.5, 0, 80000000, 80000000, 0, NOW())`,
      [user.id, eventOne.rows[0].id]
    );

    await db.query(
      `INSERT INTO market_updates
       (user_id, event_id, prev_prob, new_prob, share_type, stake_amount, stake_amount_ledger, shares_acquired, hold_until, created_at)
       VALUES ($1, $2, 0.55, 0.62, 'yes', 80.0, 80000000, 12.5, NOW() + INTERVAL '5 days', NOW() - INTERVAL '1 day')`,
      [user.id, eventOne.rows[0].id]
    );

    const res = await request(app)
      .get('/api/analytics/predictions/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.summary.total_predictions).toBe(3);
    expect(res.body.summary.pending_predictions).toBe(1);
    expect(res.body.summary.resolved_predictions).toBe(2);
    expect(res.body.summary.correct_predictions).toBe(1);
    expect(res.body.summary.incorrect_predictions).toBe(1);
    expect(res.body.summary.accuracy_percent).toBe(50);
    expect(res.body.activity.open_positions).toBe(1);
    expect(res.body.activity.active_markets).toBe(1);
    expect(res.body.activity.available_reputation).toBe(920);
    expect(res.body.activity.staked_reputation).toBe(80);
    expect(res.body.recent_predictions).toHaveLength(3);
    expect(res.body.open_positions).toHaveLength(1);
    expect(res.body.open_positions[0].event_title).toBe('Will inflation fall by Q4?');
    expect(res.body.open_positions[0].exposure_label).toBe('YES');

    // Persuasion section present with empty defaults for a user without payouts.
    expect(res.body.persuasion).toMatchObject({
      reward_rp: 0,
      payout_count: 0,
      rewarded_posts: 0,
      episode_count: 0
    });
    expect(res.body.persuasion.recent_payouts).toEqual([]);
  });

  test('surfaces persuasion rewards and per-post signal summaries', async () => {
    const author = await createUser('persuasionauthor');
    const trader = await createUser('persuasiontrader');
    cleanup.userIds.push(author.id, trader.id);

    const event = await db.query(
      `INSERT INTO events (title, details, closing_date, event_type, market_prob, cumulative_stake)
       VALUES ('Will the launch succeed?', 'Launch event', NOW() + INTERVAL '15 days', 'binary', 0.5, 50.0)
       RETURNING id`
    );
    cleanup.eventIds.push(event.rows[0].id);

    const post = await db.query(
      `INSERT INTO posts (user_id, content, created_at) VALUES ($1, 'big launch take', NOW()) RETURNING id`,
      [author.id]
    );

    const update = await db.query(
      `INSERT INTO market_updates
       (user_id, event_id, prev_prob, new_prob, share_type, stake_amount, stake_amount_ledger, shares_acquired, hold_until, created_at, referral_post_id)
       VALUES ($1, $2, 0.50, 0.58, 'yes', 20.0, 20000000, 4.1, NOW() + INTERVAL '5 days', NOW(), $3)
       RETURNING id`,
      [trader.id, event.rows[0].id, post.rows[0].id]
    );

    const episode = await db.query(
      `INSERT INTO post_signal_episodes
       (market_update_id, post_id, event_id, trader_user_id, episode_bucket_start, episode_type, is_meaningful, p_before, p_after, s_early)
       VALUES ($1, $2, $3, $4, NOW(), 'attention', TRUE, 0.50, 0.58, 0.4)
       RETURNING id`,
      [update.rows[0].id, post.rows[0].id, event.rows[0].id, trader.id]
    );

    await db.query(
      `INSERT INTO post_signal_reward_payouts
       (episode_id, post_id, author_user_id, event_id, component, score_component, mint_rate_snapshot, reward_ledger, payout_status)
       VALUES ($1, $2, $3, $4, 'early', 0.028, 1000000, 2500000, 'minted')`,
      [episode.rows[0].id, post.rows[0].id, author.id, event.rows[0].id]
    );

    const dashboardRes = await request(app)
      .get('/api/analytics/predictions/me')
      .set('Authorization', `Bearer ${author.token}`);

    expect(dashboardRes.statusCode).toBe(200);
    expect(dashboardRes.body.persuasion.reward_rp).toBeCloseTo(2.5);
    expect(dashboardRes.body.persuasion.payout_count).toBe(1);
    expect(dashboardRes.body.persuasion.rewarded_posts).toBe(1);
    expect(dashboardRes.body.persuasion.episode_count).toBe(1);
    expect(dashboardRes.body.persuasion.recent_payouts).toHaveLength(1);
    expect(dashboardRes.body.persuasion.recent_payouts[0]).toMatchObject({
      post_id: post.rows[0].id,
      event_title: 'Will the launch succeed?',
      component: 'early'
    });
    expect(dashboardRes.body.persuasion.recent_payouts[0].reward_rp).toBeCloseTo(2.5);

    const signalRes = await request(app)
      .get(`/api/posts/${post.rows[0].id}/signal-summary`)
      .set('Authorization', `Bearer ${trader.token}`);

    expect(signalRes.statusCode).toBe(200);
    expect(signalRes.body.episode_count).toBe(1);
    expect(signalRes.body.market_count).toBe(1);
    expect(signalRes.body.max_prob_move).toBeCloseTo(0.08);
    expect(signalRes.body.reward_rp).toBeCloseTo(2.5);
  });
});
