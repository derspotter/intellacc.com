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

describe('Network graph endpoint', () => {
  const cleanup = { userIds: [] };

  afterAll(async () => {
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('returns nodes with follower counts and follow edges', async () => {
    const alice = await createUser('netalice');
    const bob = await createUser('netbob');
    cleanup.userIds.push(alice.id, bob.id);

    const follow = await request(app)
      .post(`/api/users/${alice.id}/follow`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect([200, 201]).toContain(follow.statusCode);

    const res = await request(app)
      .get('/api/network/graph')
      .set('Authorization', `Bearer ${alice.token}`);

    expect(res.statusCode).toBe(200);
    const aliceNode = res.body.nodes.find((n) => n.id === alice.id);
    const bobNode = res.body.nodes.find((n) => n.id === bob.id);
    expect(aliceNode).toBeTruthy();
    expect(bobNode).toBeTruthy();
    expect(aliceNode.followers).toBeGreaterThanOrEqual(1);
    expect(res.body.edges).toContainEqual([bob.id, alice.id]);
  });
});
