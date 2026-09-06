const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(60000);

// "Propose market" from a post: any logged-in user can turn a post into a
// market question submission. The submission remembers its source post, and
// once the question is approved the post is linked to the new market
// automatically so the market chip appears without a manual attach.

const LEDGER_SCALE = 1_000_000n;
const cleanup = { users: new Set(), events: new Set(), posts: new Set() };
const password = 'testpass123';

const createUser = async (label) => {
  const tag = `${label}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const email = `${tag}@example.com`;
  const hash = await bcrypt.hash(password, 10);
  const r = await db.query(
    `INSERT INTO users (email, username, password_hash, created_at, updated_at, rp_balance_ledger, email_verified_at, verification_tier)
     VALUES ($1, $2, $3, NOW(), NOW(), $4::bigint, NOW(), 1) RETURNING id`,
    [email, tag, hash, (1_000n * LEDGER_SCALE).toString()]
  );
  cleanup.users.add(r.rows[0].id);
  return { id: r.rows[0].id, email };
};

const login = async (email) => {
  const res = await request(app).post('/api/login').send({ email, password });
  expect(res.statusCode).toBe(200);
  return res.body.token;
};

const createPost = async (userId, content) => {
  const r = await db.query('INSERT INTO posts (user_id, content) VALUES ($1, $2) RETURNING id', [userId, content]);
  cleanup.posts.add(r.rows[0].id);
  return r.rows[0].id;
};

const proposeFromPost = (token, postId, extra = {}) =>
  request(app)
    .post('/api/market-questions')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: `Will there be global cybersocialism before 2027? ${Date.now()}`,
      details: 'Resolves YES if ... (proposed from a post)',
      closing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      source_post_id: postId,
      ...extra
    });

const approveWithFiveValidators = async (submissionId) => {
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    const v = await createUser(`mqfp_val${i}`);
    last = await request(app)
      .post(`/api/market-questions/${submissionId}/reviews`)
      .set('Authorization', `Bearer ${await login(v.email)}`)
      .send({ vote: i < 4 ? 'approve' : 'reject', note: `vote-${i}` });
    expect(last.statusCode).toBe(200);
  }
  expect(last.body.finalized).toBe(true);
  expect(last.body.approved).toBe(true);
  cleanup.events.add(last.body.approved_event_id);
  return last.body.approved_event_id;
};

const linkFor = async (postId, eventId) => {
  const r = await db.query(
    'SELECT stance, source, confirmed FROM post_market_links WHERE post_id = $1 AND event_id = $2',
    [postId, eventId]
  );
  return r.rows[0] || null;
};

describe('Market question proposed from a post', () => {
  afterAll(async () => {
    if (cleanup.events.size) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    if (cleanup.posts.size) await db.query('DELETE FROM posts WHERE id = ANY($1::int[])', [Array.from(cleanup.posts)]);
    if (cleanup.users.size) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [Array.from(cleanup.users)]);
  });

  test('a reader can propose a market from someone else\'s post and the submission remembers it', async () => {
    const author = await createUser('mqfp_author');
    const reader = await createUser('mqfp_reader');
    const postId = await createPost(author.id, 'Maybe we should make a prediction market about it.');

    const res = await proposeFromPost(await login(reader.email), postId);
    expect(res.statusCode).toBe(201);
    expect(res.body.submission.source_post_id).toBe(postId);

    const fetched = await request(app)
      .get(`/api/market-questions/${res.body.submission.id}`)
      .set('Authorization', `Bearer ${await login(reader.email)}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body.submission.source_post_id).toBe(postId);
  });

  test('approval links the source post to the new market as reader_suggested', async () => {
    const author = await createUser('mqfp_author');
    const reader = await createUser('mqfp_reader');
    const postId = await createPost(author.id, 'A post a reader turns into a market.');

    const res = await proposeFromPost(await login(reader.email), postId);
    expect(res.statusCode).toBe(201);
    const eventId = await approveWithFiveValidators(res.body.submission.id);

    const link = await linkFor(postId, eventId);
    expect(link).toEqual({ stance: 'related', source: 'reader_suggested', confirmed: true });
  });

  test('when the author proposes from their own post the link is author_confirmed', async () => {
    const author = await createUser('mqfp_author');
    const postId = await createPost(author.id, 'My own claim, my own market.');

    const res = await proposeFromPost(await login(author.email), postId);
    expect(res.statusCode).toBe(201);
    const eventId = await approveWithFiveValidators(res.body.submission.id);

    const link = await linkFor(postId, eventId);
    expect(link).toEqual({ stance: 'related', source: 'author_confirmed', confirmed: true });
  });

  test('a rejected question links nothing', async () => {
    const author = await createUser('mqfp_author');
    const reader = await createUser('mqfp_reader');
    const postId = await createPost(author.id, 'A post whose market gets rejected.');
    const res = await proposeFromPost(await login(reader.email), postId);
    expect(res.statusCode).toBe(201);

    let last = null;
    for (let i = 0; i < 5; i += 1) {
      const v = await createUser(`mqfp_rej${i}`);
      last = await request(app)
        .post(`/api/market-questions/${res.body.submission.id}/reviews`)
        .set('Authorization', `Bearer ${await login(v.email)}`)
        .send({ vote: 'reject', note: `vote-${i}` });
    }
    expect(last.body.finalized).toBe(true);
    expect(last.body.approved).toBe(false);
    const links = await db.query('SELECT 1 FROM post_market_links WHERE post_id = $1', [postId]);
    expect(links.rows).toHaveLength(0);
  });

  test('a source_post_id that does not exist is a 400', async () => {
    const reader = await createUser('mqfp_reader');
    const res = await proposeFromPost(await login(reader.email), 999999999);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/source_post_id/);
  });

  test('submissions without a source post still work and report null', async () => {
    const reader = await createUser('mqfp_reader');
    const res = await proposeFromPost(await login(reader.email), undefined);
    expect(res.statusCode).toBe(201);
    expect(res.body.submission.source_post_id).toBeNull();
  });
});
