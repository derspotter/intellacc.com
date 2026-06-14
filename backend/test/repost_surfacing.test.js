const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const makeUser = async (label) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  await request(app).post('/api/users/register').send({ username: unique, email, password: 'testpass123' });
  const login = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  expect(login.statusCode).toBe(200);
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const id = row.rows[0].id;
  // Satisfy requireEmailVerified for POST /posts.
  await db.query('UPDATE users SET email_verified_at = NOW(), verification_tier = GREATEST(verification_tier, 1) WHERE id = $1', [id]);
  return { id, username: unique, token: login.body.token };
};

const getPost = (id, token) =>
  request(app).get(`/api/posts/${id}`).set('Authorization', `Bearer ${token}`);

describe('Repost surfacing (count + viewer flag)', () => {
  const cleanup = { userIds: [] };

  afterAll(async () => {
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('a post exposes repost_count and a viewer-relative reposted_by_user flag', async () => {
    const author = await makeUser('rpauthor');
    const reposter = await makeUser('rpreposter');
    cleanup.userIds.push(author.id, reposter.id);

    // Author creates a post.
    const created = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${author.token}`)
      .send({ content: `repost target ${Date.now()}` });
    expect(created.statusCode).toBe(201);
    const postId = created.body.id;

    // Before any repost: count 0, not reposted by reposter.
    const before = await getPost(postId, reposter.token);
    expect(before.statusCode).toBe(200);
    expect(before.body.repost_count).toBe(0);
    expect(before.body.reposted_by_user).toBe(false);

    // Reposter reposts it.
    const repost = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${reposter.token}`)
      .send({ repost_id: postId });
    expect(repost.statusCode).toBe(201);

    // After: count 1; reposted_by_user true for the reposter, false for the author.
    const seenByReposter = await getPost(postId, reposter.token);
    expect(seenByReposter.body.repost_count).toBe(1);
    expect(seenByReposter.body.reposted_by_user).toBe(true);

    const seenByAuthor = await getPost(postId, author.token);
    expect(seenByAuthor.body.repost_count).toBe(1);
    expect(seenByAuthor.body.reposted_by_user).toBe(false);
  });
});
