const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

// Regression: a profile link built from a missing id navigated to
// /users/undefined, and Postgres rejected the integer cast with a 500
// "Error fetching user". Non-numeric ids must be a clean 400 on every
// /users/:id route.

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  return { id: row.rows[0].id, token: loginRes.body.token };
};

describe('/users/:id parameter validation', () => {
  let viewer;

  beforeAll(async () => {
    viewer = await createUser('idparam');
  });

  afterAll(async () => {
    await db.query('DELETE FROM users WHERE id = $1', [viewer.id]);
  });

  const badIds = ['undefined', 'null', 'abc', '12abc', '-1', '0'];
  const routes = [
    (id) => `/api/users/${id}`,
    (id) => `/api/users/${id}/followers`,
    (id) => `/api/users/${id}/following`,
    (id) => `/api/users/${id}/following-status`,
    (id) => `/api/users/${id}/calibration`,
    (id) => `/api/users/${id}/positions`,
  ];

  test.each(badIds)('GET /users/%s and sub-routes return 400, never 500', async (badId) => {
    for (const build of routes) {
      const res = await request(app).get(build(badId)).set('Authorization', `Bearer ${viewer.token}`);
      expect({ route: build(badId), status: res.statusCode }).toEqual({ route: build(badId), status: 400 });
      expect(res.body.message).toBe('Invalid user id');
    }
  });

  test('a real numeric id still resolves', async () => {
    const res = await request(app).get(`/api/users/${viewer.id}`).set('Authorization', `Bearer ${viewer.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(viewer.id);
  });

  test('follow/unfollow with a bad id return 400', async () => {
    const post = await request(app).post('/api/users/undefined/follow').set('Authorization', `Bearer ${viewer.token}`);
    expect(post.statusCode).toBe(400);
    const del = await request(app).delete('/api/users/undefined/follow').set('Authorization', `Bearer ${viewer.token}`);
    expect(del.statusCode).toBe(400);
  });
});
