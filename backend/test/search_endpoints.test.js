const request = require('supertest');
const crypto = require('crypto');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = `${label}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const email = `${unique}@example.com`;
  const username = unique;
  const password = 'testpass123';

  const registerRes = await request(app)
    .post('/api/users/register')
    .send({ username, email, password });
  expect(registerRes.statusCode).toBe(201);

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });
  expect(loginRes.statusCode).toBe(200);

  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;

  await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [userId]);

  return {
    id: userId,
    email,
    username,
    token: loginRes.body.token
  };
};

const createPost = async (userId, content) => {
  const result = await db.query(
    'INSERT INTO posts (user_id, content, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id',
    [userId, content]
  );
  return result.rows[0].id;
};

const ensureUserPostViewsTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_post_views (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, post_id)
    );
  `);
};

const userPostViewsTableExists = async () => {
  const result = await db.query(
    "SELECT to_regclass('public.user_post_views')::text AS name"
  );
  return !!result.rows[0]?.name;
};

describe('Search endpoints', () => {
  const createdUserIds = [];

  afterEach(async () => {
    if (!createdUserIds.length) return;

    for (const userId of [...createdUserIds]) {
      if (await userPostViewsTableExists()) {
        await db.query('DELETE FROM user_post_views WHERE user_id = $1', [userId]);
      }
      await db.query('DELETE FROM follows WHERE follower_id = $1 OR following_id = $1', [userId]);
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    createdUserIds.length = 0;
  });

  test('returns following-state in user search results when requested', async () => {
    const actor = await createUser('search_actor');
    const target = await createUser('search_target');
    createdUserIds.push(actor.id, target.id);

    const followRes = await request(app)
      .post(`/api/users/${target.id}/follow`)
      .set('Authorization', `Bearer ${actor.token}`);
    expect(followRes.statusCode).toBe(201);

    const searchRes = await request(app)
      .get('/api/users/search')
      .query({ q: target.username, include_following: '1' })
      .set('Authorization', `Bearer ${actor.token}`);

    expect(searchRes.statusCode).toBe(200);
    const targetResult = (searchRes.body || []).find((user) => user.id === target.id);
    expect(targetResult).toBeDefined();
    expect(targetResult.is_following).toBe(true);
  });

  test('filters /api/posts scope=seen to only include seen posts', async () => {
    await ensureUserPostViewsTable();

    const actor = await createUser('search_seen_actor');
    const author = await createUser('search_seen_author');
    createdUserIds.push(actor.id, author.id);

    const query = `searchscope_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    const seenPostOne = await createPost(author.id, `${query} first`);
    const seenPostTwo = await createPost(author.id, `${query} second`);
    const unseenPost = await createPost(author.id, `${query} third`);

    await db.query(
      `
      INSERT INTO user_post_views (user_id, post_id)
      VALUES ($1, $2), ($1, $3), ($1, $4)
      ON CONFLICT DO NOTHING
      `,
      [actor.id, seenPostOne, seenPostTwo, unseenPost]
    );

    await db.query(
      `
      UPDATE user_post_views
      SET seen_at = NOW() - INTERVAL '120 days'
      WHERE user_id = $1 AND post_id = $2
      `,
      [actor.id, unseenPost]
    );

    const seenRes = await request(app)
      .get('/api/posts')
      .query({ scope: 'seen', q: query })
      .set('Authorization', `Bearer ${actor.token}`);

    expect(seenRes.statusCode).toBe(200);
    const returnedIds = (seenRes.body.items || []).map((post) => post.id);
    expect(returnedIds).toContain(seenPostOne);
    expect(returnedIds).toContain(seenPostTwo);
    expect(returnedIds).not.toContain(unseenPost);
  });
});
