const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const login = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: row.rows[0].id, token: login.body.token };
};

describe('Feed weights', () => {
  const cleanup = { userIds: [] };
  afterAll(async () => {
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('GET returns null before any save; PUT validates sum=100; GET returns saved', async () => {
    const u = await createUser('fw');
    cleanup.userIds.push(u.id);
    const auth = { Authorization: `Bearer ${u.token}` };

    const before = await request(app).get('/api/users/me/feed-weights').set(auth);
    expect(before.statusCode).toBe(200);
    expect(before.body.weights).toBeNull();

    const bad = await request(app).put('/api/users/me/feed-weights').set(auth)
      .send({ accuracy: 50, followers: 30, likes: 10, views: 5 });
    expect(bad.statusCode).toBe(400);

    const ok = await request(app).put('/api/users/me/feed-weights').set(auth)
      .send({ accuracy: 40, followers: 25, likes: 20, views: 15 });
    expect(ok.statusCode).toBe(200);

    const after = await request(app).get('/api/users/me/feed-weights').set(auth);
    expect(after.body.weights).toEqual({ accuracy: 40, followers: 25, likes: 20, views: 15 });
  });

  test('feed payload exposes author_accuracy, author_followers, view_count', async () => {
    const author = await createUser('fwauthor');
    cleanup.userIds.push(author.id);
    await db.query('UPDATE users SET email_verified_at = NOW(), verification_tier = GREATEST(verification_tier,1) WHERE id = $1', [author.id]);
    const created = await request(app).post('/api/posts')
      .set('Authorization', `Bearer ${author.token}`)
      .send({ content: `feed signal post ${Date.now()}` });
    expect(created.statusCode).toBe(201);

    const res = await request(app).get('/api/posts').query({ limit: 5 });
    expect(res.statusCode).toBe(200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    const row = items.find((p) => p.id === created.body.id);
    expect(row).toBeTruthy();
    expect('author_accuracy' in row).toBe(true);
    expect(typeof row.author_followers).toBe('number');
    expect(typeof row.view_count).toBe('number');
  });
});
