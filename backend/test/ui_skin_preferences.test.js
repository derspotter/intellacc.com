const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  const userRes = await db.query('SELECT id FROM users WHERE email = $1', [email]);

  return {
    id: userRes.rows[0].id,
    token: loginRes.body.token
  };
};

describe('UI skin preferences API', () => {
  const cleanup = [];

  afterAll(async () => {
    for (const row of cleanup) {
      await db.query('DELETE FROM users WHERE id = $1', [row.id]);
    }
  });

  test('GET /api/users/me/preferences requires authentication', async () => {
    const res = await request(app).get('/api/users/me/preferences');
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/users/me/preferences returns null by default', async () => {
    const user = await createUser('skinpref_default');
    cleanup.push({ id: user.id });

    const res = await request(app)
      .get('/api/users/me/preferences')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ skin: null });
  });

  test('PUT /api/users/me/preferences rejects invalid values', async () => {
    const user = await createUser('skinpref_invalid');
    cleanup.push({ id: user.id });

    const res = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ skin: 'neon' });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Skin must be one of: van, terminal');
  });

  test('PUT /api/users/me/preferences persists and returns selected skin', async () => {
    const user = await createUser('skinpref_update');
    cleanup.push({ id: user.id });

    const putRes = await request(app)
      .put('/api/users/me/preferences')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ skin: 'terminal' });

    expect(putRes.statusCode).toBe(200);
    expect(putRes.body).toEqual({ skin: 'terminal' });

    const getRes = await request(app)
      .get('/api/users/me/preferences')
      .set('Authorization', `Bearer ${user.token}`);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toEqual({ skin: 'terminal' });
  });
});

