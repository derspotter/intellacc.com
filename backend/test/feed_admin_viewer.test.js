const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

// Regression: the admin block-bypass (viewerId = NULL) must only relax the
// user_blocks visibility check — it must never leak into identity-dependent
// predicates (follow scoping, own posts, likes, seen joins), which made the
// admin's feed come back empty.

const createUser = async (label, { admin = false } = {}) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const id = row.rows[0].id;
  if (admin) {
    // Promote before login so the JWT carries role=admin.
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
  }
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  return { id, username, token: loginRes.body.token };
};

const insertPost = async (userId, content) => {
  const res = await db.query(
    'INSERT INTO posts (user_id, content) VALUES ($1, $2) RETURNING id',
    [userId, content]
  );
  return res.rows[0].id;
};

describe('Feed scoping for admin viewers', () => {
  const cleanup = { userIds: [] };
  let admin;
  let followee;
  let adminPostId;
  let followeePostId;

  beforeAll(async () => {
    admin = await createUser('admfeed', { admin: true });
    followee = await createUser('admfollowee');
    cleanup.userIds.push(admin.id, followee.id);

    adminPostId = await insertPost(admin.id, 'admin own post for feed regression');
    followeePostId = await insertPost(followee.id, 'followee post for feed regression');

    const followRes = await request(app)
      .post(`/api/users/${followee.id}/follow`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect([200, 201]).toContain(followRes.statusCode);
  });

  afterAll(async () => {
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('admin sees own posts and followed users\' posts in /api/feed', async () => {
    const res = await request(app)
      .get('/api/feed')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.statusCode).toBe(200);
    const posts = res.body.items;
    expect(Array.isArray(posts)).toBe(true);
    const ids = posts.map((p) => p.id);
    expect(ids).toContain(adminPostId);
    expect(ids).toContain(followeePostId);
  });

  test('admin still sees posts of users who blocked them (block bypass preserved)', async () => {
    const blocker = await createUser('admblocker');
    cleanup.userIds.push(blocker.id);
    const blockerPostId = await insertPost(blocker.id, 'blocker post should stay visible to admin');

    const followRes = await request(app)
      .post(`/api/users/${blocker.id}/follow`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect([200, 201]).toContain(followRes.statusCode);

    const blockRes = await request(app)
      .post(`/api/users/${admin.id}/block`)
      .set('Authorization', `Bearer ${blocker.token}`);
    expect([200, 201]).toContain(blockRes.statusCode);

    const res = await request(app)
      .get('/api/feed')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    const posts = res.body.items;
    expect(posts.map((p) => p.id)).toContain(blockerPostId);
  });

  test('liked_by_user reflects the admin\'s own likes in /api/posts', async () => {
    const likeRes = await request(app)
      .post(`/api/posts/${followeePostId}/like`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect([200, 201]).toContain(likeRes.statusCode);

    const res = await request(app)
      .get('/api/posts')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(200);
    const posts = res.body.items;
    const row = posts.find((p) => p.id === followeePostId);
    expect(row).toBeTruthy();
    expect(row.liked_by_user).toBe(true);
  });
});
