const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const ensurePersuasiveSchema = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS post_market_matches (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      match_score DECIMAL(10, 6) NOT NULL DEFAULT 0.0,
      match_method VARCHAR(20) NOT NULL DEFAULT 'fts_v1',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      CONSTRAINT unique_post_market_match UNIQUE (post_id, event_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_post_market_matches_post
      ON post_market_matches(post_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_post_market_matches_event
      ON post_market_matches(event_id)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS post_market_clicks (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      consumed_at TIMESTAMP WITH TIME ZONE,
      consumed_by_market_update_id INTEGER,
      CONSTRAINT post_market_clicks_post_event_user_unique_once_per_click_window
        UNIQUE (post_id, event_id, user_id, clicked_at)
        )
  `);

  await db.query(`
    ALTER TABLE post_market_clicks
      DROP CONSTRAINT IF EXISTS post_market_clicks_post_event_user_unique_once_per_click_window
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_post_market_clicks_active_user_post_event
      ON post_market_clicks (post_id, event_id, user_id)
      WHERE consumed_at IS NULL
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_post_market_clicks_user_event_clicked
      ON post_market_clicks(user_id, event_id, clicked_at DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_post_market_clicks_expires
      ON post_market_clicks(expires_at)
  `);

  await db.query(`
    ALTER TABLE market_updates
      ADD COLUMN IF NOT EXISTS referral_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL
  `);

  await db.query(`
    ALTER TABLE market_updates
      ADD COLUMN IF NOT EXISTS referral_click_id INTEGER
  `);

  await db.query(`
    ALTER TABLE market_updates
      ADD COLUMN IF NOT EXISTS had_prior_position BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_market_updates_referral_post
      ON market_updates(referral_post_id, event_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_market_updates_referral_click
      ON market_updates(referral_click_id)
  `);
};

const makeUser = async (label, verificationTier) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  const username = unique;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  expect(loginRes.statusCode).toBe(200);

  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;

  if (verificationTier !== undefined) {
    await db.query('UPDATE users SET verification_tier = $1 WHERE id = $2', [verificationTier, userId]);
  }

  return {
    id: userId,
    token: loginRes.body.token
  };
};

const createEvent = async ({ closingDate = new Date(Date.now() + (24 * 60 * 60 * 1000)), outcome = null } = {}) => {
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, outcome, event_type, category)
     VALUES ($1, $2, $3, $4, 'binary', 'test')
     RETURNING id, title, closing_date`,
    [`Persuasive alpha event ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'Will this test pass?', closingDate, outcome]
  );
  return result.rows[0];
};

const createPost = async (user) => {
  const res = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ content: `Persuasive alpha test post ${Date.now()}_${Math.floor(Math.random() * 10000)}` });

  expect(res.statusCode).toBe(201);
  expect(res.body.id).toBeDefined();
  return res.body;
};

const createMatch = async ({ postId, eventId, matchScore = 0.9 }) => {
  const result = await db.query(
    'INSERT INTO post_market_matches (post_id, event_id, match_score, match_method) VALUES ($1, $2, $3, $4) RETURNING id',
    [postId, eventId, matchScore, 'fts_v1']
  );
  return result.rows[0];
};

const createClick = async ({ postId, eventId, token }) => {
  const res = await request(app)
    .post(`/api/posts/${postId}/market-click`)
    .set('Authorization', `Bearer ${token}`)
    .send({ event_id: eventId });

  return res;
};

const waitForClickConsumed = async (clickId, expectedMarketUpdateId) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const clickRow = await db.query(
      'SELECT consumed_by_market_update_id, consumed_at FROM post_market_clicks WHERE id = $1',
      [clickId]
    );

    if (
      clickRow.rows.length > 0 &&
      clickRow.rows[0].consumed_at &&
      Number(clickRow.rows[0].consumed_by_market_update_id) === Number(expectedMarketUpdateId)
    ) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
};

describe('Persuasive alpha attribution APIs', () => {
  const cleanup = {
    users: new Set(),
    posts: new Set(),
    events: new Set(),
    matches: new Set(),
    clicks: new Set()
  };

  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        new_prob: 0.55,
        cumulative_stake: 5.0,
        market_update_id: 1
      })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  beforeAll(async () => {
    await ensurePersuasiveSchema();
  });

  afterAll(async () => {
    if (cleanup.clicks.size) {
      await db.query(
        'DELETE FROM post_market_clicks WHERE id = ANY($1::int[])',
        [Array.from(cleanup.clicks)]
      );
    }

    if (cleanup.matches.size) {
      await db.query(
        'DELETE FROM post_market_matches WHERE id = ANY($1::int[])',
        [Array.from(cleanup.matches)]
      );
    }

    if (cleanup.posts.size) {
      await db.query('DELETE FROM posts WHERE id = ANY($1::int[])', [Array.from(cleanup.posts)]);
    }

    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }

    for (const userId of cleanup.users) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('POST /api/posts/:postId/market-click records a valid referral click', async () => {
    const author = await makeUser('pa_author', 1);
    const trader = await makeUser('pa_trader', 1);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);

    const match = await createMatch({ postId: post.id, eventId: event.id });
    cleanup.matches.add(match.id);

    const res = await createClick({ postId: post.id, eventId: event.id, token: trader.token });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.click).toHaveProperty('id');
    expect(res.body.click).toHaveProperty('clicked_at');
    expect(res.body.click).toHaveProperty('expires_at');

    const clickRow = await db.query(
      'SELECT post_id, event_id, user_id FROM post_market_clicks WHERE id = $1',
      [res.body.click.id]
    );
    expect(clickRow.rows[0]).toMatchObject({
      post_id: post.id,
      event_id: event.id,
      user_id: trader.id
    });
    cleanup.clicks.add(res.body.click.id);
  });

  test('POST /api/posts/:postId/market-click is idempotent for an active unconsumed click', async () => {
    const author = await makeUser('pa_author_idempotent', 1);
    const trader = await makeUser('pa_trader_idempotent', 1);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);

    const match = await createMatch({ postId: post.id, eventId: event.id });
    cleanup.matches.add(match.id);

    const first = await createClick({ postId: post.id, eventId: event.id, token: trader.token });
    const second = await createClick({ postId: post.id, eventId: event.id, token: trader.token });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.body.click.id).toBe(first.body.click.id);

    cleanup.clicks.add(first.body.click.id);
  });

  test('GET /api/posts/:postId/markets returns ordered matches', async () => {
    const author = await makeUser('pa_author2', 1);
    cleanup.users.add(author.id);

    const eventA = await createEvent();
    const eventB = await createEvent();
    const post = await createPost(author);
    cleanup.events.add(eventA.id);
    cleanup.events.add(eventB.id);
    cleanup.posts.add(post.id);

    const matchA = await createMatch({ postId: post.id, eventId: eventA.id, matchScore: 0.32 });
    const matchB = await createMatch({ postId: post.id, eventId: eventB.id, matchScore: 0.88 });
    cleanup.matches.add(matchA.id);
    cleanup.matches.add(matchB.id);

    const res = await request(app)
      .get(`/api/posts/${post.id}/markets`)
      .set('Authorization', `Bearer ${author.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.post_id).toBe(post.id);
    expect(Array.isArray(res.body.markets)).toBe(true);
    expect(res.body.markets).toHaveLength(2);
    expect(Number(res.body.markets[0].match_score)).toBeGreaterThanOrEqual(Number(res.body.markets[1].match_score));
    expect(res.body.markets.map((market) => Number(market.event_id)).sort()).toEqual([eventA.id, eventB.id].sort());
  });

  test('Market update route links click attribution to trade payload and consumes click record', async () => {
    const author = await makeUser('pa_author3', 1);
    const trader = await makeUser('pa_trader3', 2);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);

    const match = await createMatch({ postId: post.id, eventId: event.id });
    cleanup.matches.add(match.id);

    const clickRes = await createClick({ postId: post.id, eventId: event.id, token: trader.token });
    expect(clickRes.statusCode).toBe(201);
    const clickId = clickRes.body.click.id;
    cleanup.clicks.add(clickId);

    const marketUpdateId = 4242;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ new_prob: 0.57, cumulative_stake: 8.0, market_update_id: marketUpdateId })
    });

    const updateRes = await request(app)
      .post(`/api/events/${event.id}/update`)
      .set('Authorization', `Bearer ${trader.token}`)
      .send({ user_id: trader.id, stake: 1.5, target_prob: 0.6 });

    expect(updateRes.statusCode).toBe(200);

    expect(global.fetch).toHaveBeenCalled();
    const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
    const payload = JSON.parse(calledOptions.body || '{}');

    expect(calledUrl).toBe(`http://prediction-engine:3001/events/${event.id}/update`);
    expect(payload.referral_post_id).toBe(post.id);
    expect(payload.referral_click_id).toBe(clickId);
    expect(payload.user_id).toBe(trader.id);
    expect(payload.stake).toBe(1.5);

    const clickConsumed = await waitForClickConsumed(clickId, marketUpdateId);
    expect(clickConsumed).toBe(true);
  });

  test('Market update uses the latest non-self click for referral and ignores fallback self clicks', async () => {
    const postAuthor = await makeUser('pa_post_author', 1);
    const trader = await makeUser('pa_trader_fallback', 2);
    cleanup.users.add(postAuthor.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    const ownPost = await createPost(trader);
    const targetPost = await createPost(postAuthor);
    cleanup.events.add(event.id);
    cleanup.posts.add(ownPost.id);
    cleanup.posts.add(targetPost.id);

    const matchForOwn = await createMatch({ postId: ownPost.id, eventId: event.id, matchScore: 0.85 });
    const matchForTarget = await createMatch({ postId: targetPost.id, eventId: event.id, matchScore: 0.9 });
    cleanup.matches.add(matchForOwn.id);
    cleanup.matches.add(matchForTarget.id);

    const fallbackClickRes = await createClick({ postId: targetPost.id, eventId: event.id, token: trader.token });
    const selfClickRes = await createClick({ postId: ownPost.id, eventId: event.id, token: trader.token });
    expect(selfClickRes.statusCode).toBe(201);
    expect(fallbackClickRes.statusCode).toBe(201);

    const selfClickId = selfClickRes.body.click.id;
    const fallbackClickId = fallbackClickRes.body.click.id;
    cleanup.clicks.add(selfClickId);
    cleanup.clicks.add(fallbackClickId);

    const marketUpdateId = 9001;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ new_prob: 0.66, cumulative_stake: 5.5, market_update_id: marketUpdateId })
    });

    const updateRes = await request(app)
      .post(`/api/events/${event.id}/update`)
      .set('Authorization', `Bearer ${trader.token}`)
      .send({ user_id: trader.id, stake: 2.5, target_prob: 0.72 });

    expect(updateRes.statusCode).toBe(200);
    const payload = JSON.parse(global.fetch.mock.calls[0]?.[1]?.body || '{}');
    expect(payload.referral_post_id).toBe(targetPost.id);
    expect(payload.referral_click_id).toBe(fallbackClickId);
    expect(payload.referral_click_id).not.toBe(selfClickId);
  });

  test('Concurrent market update requests consume at most one active click', async () => {
    const author = await makeUser('pa_author_concurrency', 1);
    const trader = await makeUser('pa_trader_concurrency', 2);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);
    const match = await createMatch({ postId: post.id, eventId: event.id, matchScore: 0.93 });
    cleanup.matches.add(match.id);

    const clickRes = await createClick({ postId: post.id, eventId: event.id, token: trader.token });
    expect(clickRes.statusCode).toBe(201);
    cleanup.clicks.add(clickRes.body.click.id);

    const marketUpdateIds = [1111, 2222];
    global.fetch = jest.fn().mockImplementation(async () => {
      const index = global.fetch.mock.calls.length - 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        ok: true,
        json: async () => ({
          new_prob: 0.71,
          cumulative_stake: 6.0,
          market_update_id: marketUpdateIds[index % marketUpdateIds.length]
        })
      };
    });

    const [firstRes, secondRes] = await Promise.all([
      request(app)
        .post(`/api/events/${event.id}/update`)
        .set('Authorization', `Bearer ${trader.token}`)
        .send({ user_id: trader.id, stake: 1.0, target_prob: 0.65 }),
      request(app)
        .post(`/api/events/${event.id}/update`)
        .set('Authorization', `Bearer ${trader.token}`)
        .send({ user_id: trader.id, stake: 1.0, target_prob: 0.65 })
    ]);

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);

    const payloads = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body || '{}'));
    const referralPayloads = payloads.filter((payload) => payload.referral_click_id !== undefined);
    expect(referralPayloads).toHaveLength(1);
    expect(Number(referralPayloads[0].referral_click_id)).toBe(clickRes.body.click.id);

    const clickRow = await db.query(
      'SELECT consumed_by_market_update_id, consumed_at FROM post_market_clicks WHERE id = $1',
      [clickRes.body.click.id]
    );
    expect(clickRow.rows[0].consumed_by_market_update_id).toBeDefined();
    expect(clickRow.rows[0].consumed_at).toBeTruthy();
  });

  test('Market update route returns engine closed-market rejection and releases click attribution', async () => {
    const author = await makeUser('pa_author_closed', 1);
    const trader = await makeUser('pa_trader_closed', 2);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);

    const match = await createMatch({ postId: post.id, eventId: event.id });
    cleanup.matches.add(match.id);

    const clickRes = await createClick({ postId: post.id, eventId: event.id, token: trader.token });
    expect(clickRes.statusCode).toBe(201);
    const clickId = clickRes.body.click.id;
    cleanup.clicks.add(clickId);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Market closed' })
    });

    const updateRes = await request(app)
      .post(`/api/events/${event.id}/update`)
      .set('Authorization', `Bearer ${trader.token}`)
      .send({ user_id: trader.id, stake: 1.5, target_prob: 0.6 });

    expect(updateRes.statusCode).toBe(400);
    expect(updateRes.body).toMatchObject({ error: 'Market closed' });

    const payload = JSON.parse(global.fetch.mock.calls[0]?.[1]?.body || '{}');
    expect(payload.referral_click_id).toBe(clickId);

    const clickRow = await db.query(
      'SELECT consumed_by_market_update_id, consumed_at FROM post_market_clicks WHERE id = $1',
      [clickId]
    );
    expect(clickRow.rows[0].consumed_by_market_update_id).toBeNull();
    expect(clickRow.rows[0].consumed_at).toBeNull();
  });

  test('Market update route returns engine resolved-market rejection and releases click attribution', async () => {
    const author = await makeUser('pa_author_resolved', 1);
    const trader = await makeUser('pa_trader_resolved', 2);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);

    const match = await createMatch({ postId: post.id, eventId: event.id });
    cleanup.matches.add(match.id);

    const clickRes = await createClick({ postId: post.id, eventId: event.id, token: trader.token });
    expect(clickRes.statusCode).toBe(201);
    const clickId = clickRes.body.click.id;
    cleanup.clicks.add(clickId);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Market resolved' })
    });

    const updateRes = await request(app)
      .post(`/api/events/${event.id}/update`)
      .set('Authorization', `Bearer ${trader.token}`)
      .send({ user_id: trader.id, stake: 1.5, target_prob: 0.6 });

    expect(updateRes.statusCode).toBe(409);
    expect(updateRes.body).toMatchObject({ error: 'Market resolved' });

    const payload = JSON.parse(global.fetch.mock.calls[0]?.[1]?.body || '{}');
    expect(payload.referral_click_id).toBe(clickId);

    const clickRow = await db.query(
      'SELECT consumed_by_market_update_id, consumed_at FROM post_market_clicks WHERE id = $1',
      [clickId]
    );
    expect(clickRow.rows[0].consumed_by_market_update_id).toBeNull();
    expect(clickRow.rows[0].consumed_at).toBeNull();
  });

  test('Market update route rejects closed market before prediction engine for attributed click and keeps click unconsumed', async () => {
    const author = await makeUser('pa_author_route_closed', 1);
    const trader = await makeUser('pa_trader_route_closed', 2);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent({
      closingDate: new Date(Date.now() - 5 * 60 * 1000)
    });
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);

    const match = await createMatch({ postId: post.id, eventId: event.id });
    cleanup.matches.add(match.id);

    const clickRes = await createClick({ postId: post.id, eventId: event.id, token: trader.token });
    expect(clickRes.statusCode).toBe(201);
    const clickId = clickRes.body.click.id;
    cleanup.clicks.add(clickId);

    const updateRes = await request(app)
      .post(`/api/events/${event.id}/update`)
      .set('Authorization', `Bearer ${trader.token}`)
      .send({ user_id: trader.id, stake: 1.5, target_prob: 0.6 });

    expect(updateRes.statusCode).toBe(400);
    expect(updateRes.body).toMatchObject({ error: 'Market closed', event_id: event.id });
    expect(global.fetch).not.toHaveBeenCalled();

    const clickRow = await db.query(
      'SELECT consumed_by_market_update_id, consumed_at FROM post_market_clicks WHERE id = $1',
      [clickId]
    );
    expect(clickRow.rows[0].consumed_by_market_update_id).toBeNull();
    expect(clickRow.rows[0].consumed_at).toBeNull();
  });

  test('Market update route rejects resolved market before prediction engine for attributed click and keeps click unconsumed', async () => {
    const author = await makeUser('pa_author_route_resolved', 1);
    const trader = await makeUser('pa_trader_route_resolved', 2);
    cleanup.users.add(author.id);
    cleanup.users.add(trader.id);

    const event = await createEvent();
    await db.query('UPDATE events SET outcome = $1 WHERE id = $2', ['resolved', event.id]);
    const post = await createPost(author);
    cleanup.events.add(event.id);
    cleanup.posts.add(post.id);

    const match = await createMatch({ postId: post.id, eventId: event.id });
    cleanup.matches.add(match.id);

    const clickRes = await createClick({ postId: post.id, eventId: event.id, token: trader.token });
    expect(clickRes.statusCode).toBe(201);
    const clickId = clickRes.body.click.id;
    cleanup.clicks.add(clickId);

    const updateRes = await request(app)
      .post(`/api/events/${event.id}/update`)
      .set('Authorization', `Bearer ${trader.token}`)
      .send({ user_id: trader.id, stake: 1.5, target_prob: 0.6 });

    expect(updateRes.statusCode).toBe(400);
    expect(updateRes.body).toMatchObject({ error: 'Market resolved', event_id: event.id });
    expect(global.fetch).not.toHaveBeenCalled();

    const clickRow = await db.query(
      'SELECT consumed_by_market_update_id, consumed_at FROM post_market_clicks WHERE id = $1',
      [clickId]
    );
    expect(clickRow.rows[0].consumed_by_market_update_id).toBeNull();
    expect(clickRow.rows[0].consumed_at).toBeNull();
  });
});
