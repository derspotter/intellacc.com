const request = require('supertest');

jest.mock('../src/services/openRouterMatcher/postMatchPipeline', () => ({
  processPost: jest.fn().mockResolvedValue({}),
  processPostForTesting: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/services/openRouterMatcher/marketRetrieval', () => ({
  retrieveCandidateMarkets: jest.fn().mockResolvedValue([])
}));

const { app } = require('../src/index');
const db = require('../src/db');
const marketRetrieval = require('../src/services/openRouterMatcher/marketRetrieval');

jest.setTimeout(30000);

const makeUser = async (label) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username: unique, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  expect(loginRes.statusCode).toBe(200);

  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;
  await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [userId]);
  return { id: userId, token: loginRes.body.token };
};

const createEvent = async () => {
  const closingDate = new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString();
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type, category, market_prob)
     VALUES ($1, $2, $3, 'binary', 'test', 0.5)
     RETURNING id, title`,
    [`Attach event ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'Will it attach?', closingDate]
  );
  return result.rows[0];
};

const createPost = async (user) => {
  const res = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ content: `Manual attach test post ${Date.now()}_${Math.floor(Math.random() * 10000)}` });

  expect(res.statusCode).toBe(201);
  return res.body;
};

describe('Manual post market attach APIs', () => {
  const cleanup = { users: new Set(), posts: new Set(), events: new Set() };

  beforeEach(() => {
    marketRetrieval.retrieveCandidateMarkets.mockClear();
  });

  afterAll(async () => {
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

  test('POST /api/posts/:postId/market-links attaches a market with stance', async () => {
    const author = await makeUser('attach_author');
    cleanup.users.add(author.id);
    const event = await createEvent();
    cleanup.events.add(event.id);
    const post = await createPost(author);
    cleanup.posts.add(post.id);

    const res = await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${author.token}`)
      .send({ event_id: event.id, stance: 'agrees' });

    expect(res.statusCode).toBe(201);
    expect(res.body.link).toMatchObject({
      event_id: event.id,
      stance: 'agrees',
      source: 'author_confirmed',
      confirmed: true,
      match_method: 'manual'
    });

    const linkRes = await request(app)
      .get(`/api/posts/${post.id}/market-link`)
      .set('Authorization', `Bearer ${author.token}`);

    expect(linkRes.statusCode).toBe(200);
    expect(linkRes.body.linked_market).toMatchObject({
      event_id: event.id,
      confirmed: true
    });
  });

  test('attach defaults stance to related when omitted', async () => {
    const author = await makeUser('attach_default_stance');
    cleanup.users.add(author.id);
    const event = await createEvent();
    cleanup.events.add(event.id);
    const post = await createPost(author);
    cleanup.posts.add(post.id);

    const res = await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${author.token}`)
      .send({ event_id: event.id });

    expect(res.statusCode).toBe(201);
    expect(res.body.link.stance).toBe('related');
  });

  test('attach is idempotent for the same post/event pair', async () => {
    const author = await makeUser('attach_idempotent');
    cleanup.users.add(author.id);
    const event = await createEvent();
    cleanup.events.add(event.id);
    const post = await createPost(author);
    cleanup.posts.add(post.id);

    const first = await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${author.token}`)
      .send({ event_id: event.id, stance: 'agrees' });
    const second = await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${author.token}`)
      .send({ event_id: event.id, stance: 'disagrees' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.body.link.stance).toBe('disagrees');

    const rows = await db.query(
      'SELECT COUNT(*)::int AS count FROM post_market_links WHERE post_id = $1 AND event_id = $2',
      [post.id, event.id]
    );
    expect(rows.rows[0].count).toBe(1);
  });

  test('attach rejects non-authors', async () => {
    const author = await makeUser('attach_owner');
    const stranger = await makeUser('attach_stranger');
    cleanup.users.add(author.id);
    cleanup.users.add(stranger.id);
    const event = await createEvent();
    cleanup.events.add(event.id);
    const post = await createPost(author);
    cleanup.posts.add(post.id);

    const res = await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ event_id: event.id });

    expect(res.statusCode).toBe(403);
  });

  test('attach rejects unknown events', async () => {
    const author = await makeUser('attach_bad_event');
    cleanup.users.add(author.id);
    const post = await createPost(author);
    cleanup.posts.add(post.id);

    const res = await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${author.token}`)
      .send({ event_id: 99999999 });

    expect(res.statusCode).toBe(400);
  });

  test('DELETE /api/posts/:postId/market-links/:eventId detaches', async () => {
    const author = await makeUser('detach_author');
    cleanup.users.add(author.id);
    const event = await createEvent();
    cleanup.events.add(event.id);
    const post = await createPost(author);
    cleanup.posts.add(post.id);

    const attachRes = await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${author.token}`)
      .send({ event_id: event.id });
    expect(attachRes.statusCode).toBe(201);

    const res = await request(app)
      .delete(`/api/posts/${post.id}/market-links/${event.id}`)
      .set('Authorization', `Bearer ${author.token}`);

    expect(res.statusCode).toBe(200);

    const rows = await db.query(
      'SELECT 1 FROM post_market_links WHERE post_id = $1 AND event_id = $2',
      [post.id, event.id]
    );
    expect(rows.rows).toHaveLength(0);
  });

  test('detach rejects non-authors', async () => {
    const author = await makeUser('detach_owner');
    const stranger = await makeUser('detach_stranger');
    cleanup.users.add(author.id);
    cleanup.users.add(stranger.id);
    const event = await createEvent();
    cleanup.events.add(event.id);
    const post = await createPost(author);
    cleanup.posts.add(post.id);

    await request(app)
      .post(`/api/posts/${post.id}/market-links`)
      .set('Authorization', `Bearer ${author.token}`)
      .send({ event_id: event.id });

    const res = await request(app)
      .delete(`/api/posts/${post.id}/market-links/${event.id}`)
      .set('Authorization', `Bearer ${stranger.token}`);

    expect(res.statusCode).toBe(403);

    const rows = await db.query(
      'SELECT 1 FROM post_market_links WHERE post_id = $1 AND event_id = $2',
      [post.id, event.id]
    );
    expect(rows.rows).toHaveLength(1);
  });

  test('POST /api/posts/match-preview returns enriched candidates', async () => {
    const author = await makeUser('preview_author');
    cleanup.users.add(author.id);
    const event = await createEvent();
    cleanup.events.add(event.id);

    marketRetrieval.retrieveCandidateMarkets.mockResolvedValueOnce([
      {
        event_id: event.id,
        title: event.title,
        closing_date: null,
        match_score: 0.8,
        vec_score: 0.7,
        text_score: 0.6
      }
    ]);

    const res = await request(app)
      .post('/api/posts/match-preview')
      .set('Authorization', `Bearer ${author.token}`)
      .send({ text: 'Will the ECB cut rates before December this year?' });

    expect(res.statusCode).toBe(200);
    expect(res.body.markets).toHaveLength(1);
    expect(res.body.markets[0]).toMatchObject({
      event_id: event.id,
      title: event.title
    });
    expect(res.body.markets[0].market_prob).not.toBeUndefined();
  });

  test('match-preview returns empty list for short text', async () => {
    const author = await makeUser('preview_short');
    cleanup.users.add(author.id);

    const res = await request(app)
      .post('/api/posts/match-preview')
      .set('Authorization', `Bearer ${author.token}`)
      .send({ text: 'hi' });

    expect(res.statusCode).toBe(200);
    expect(res.body.markets).toEqual([]);
    expect(marketRetrieval.retrieveCandidateMarkets).not.toHaveBeenCalled();
  });

  test('match-preview requires auth', async () => {
    const res = await request(app)
      .post('/api/posts/match-preview')
      .send({ text: 'Will the ECB cut rates before December this year?' });

    expect(res.statusCode).toBe(401);
  });
});
