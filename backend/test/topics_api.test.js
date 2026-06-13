const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: row.rows[0].id, username, token: loginRes.body.token };
};

describe('Topics API', () => {
  const cleanup = { userIds: [] };
  afterAll(async () => {
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('GET /api/topics lists only user-facing topics in display order', async () => {
    const res = await request(app).get('/api/topics');
    expect(res.statusCode).toBe(200);
    expect(res.body.topics.length).toBeGreaterThanOrEqual(10);
    const slugs = res.body.topics.map((t) => t.slug);
    expect(slugs).toContain('politics');
    expect(slugs).not.toContain(null);
    expect(res.body.topics[0]).toHaveProperty('name');
    expect(res.body.topics[0]).not.toHaveProperty('embedding');
  });

  test('PUT /api/users/me/topics requires >= 3 topics and persists', async () => {
    const user = await createUser('topicuser');
    cleanup.userIds.push(user.id);
    const topicsRes = await request(app).get('/api/topics');
    const ids = topicsRes.body.topics.slice(0, 3).map((t) => t.id);

    const tooFew = await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: ids.slice(0, 2) });
    expect(tooFew.statusCode).toBe(400);

    const ok = await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: ids });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.topicIds.sort()).toEqual(ids.sort());

    const get = await request(app).get('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`);
    expect(get.statusCode).toBe(200);
    expect(get.body.topicIds.sort()).toEqual(ids.sort());
  });

  test('PUT replaces the previous set and rejects unknown ids', async () => {
    const user = await createUser('topicuser2');
    cleanup.userIds.push(user.id);
    const topicsRes = await request(app).get('/api/topics');
    const all = topicsRes.body.topics.map((t) => t.id);

    await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: all.slice(0, 3) });
    const second = await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: all.slice(1, 4) });
    expect(second.statusCode).toBe(200);
    expect(second.body.topicIds.sort()).toEqual(all.slice(1, 4).sort());

    const bad = await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: [999999, 999998, 999997] });
    expect(bad.statusCode).toBe(400);
  });

  test('GET/PUT me/topics require auth', async () => {
    expect((await request(app).get('/api/users/me/topics')).statusCode).toBe(401);
    expect((await request(app).put('/api/users/me/topics').send({ topicIds: [1, 2, 3] })).statusCode).toBe(401);
  });
});
