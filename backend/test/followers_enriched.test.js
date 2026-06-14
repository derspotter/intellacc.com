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

const follow = async (targetId, token) => {
  const res = await request(app)
    .post(`/api/users/${targetId}/follow`)
    .set('Authorization', `Bearer ${token}`);
  expect([200, 201]).toContain(res.statusCode);
};

describe('Enriched follower/following lists', () => {
  const cleanup = { userIds: [] };

  afterAll(async () => {
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  test('followers carry followers count, accuracy_percent key, and viewer-relative is_following', async () => {
    const alice = await createUser('falice');
    const bob = await createUser('fbob');
    const carol = await createUser('fcarol');
    cleanup.userIds.push(alice.id, bob.id, carol.id);

    // bob and carol both follow alice; alice follows bob only.
    await follow(alice.id, bob.token);
    await follow(alice.id, carol.token);
    await follow(bob.id, alice.token);

    // Alice views her own followers: rows = bob, carol.
    const res = await request(app)
      .get(`/api/users/${alice.id}/followers`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const bobRow = res.body.find((r) => r.id === bob.id);
    const carolRow = res.body.find((r) => r.id === carol.id);
    expect(bobRow).toBeTruthy();
    expect(carolRow).toBeTruthy();

    // Enriched fields present.
    expect(typeof bobRow.followers).toBe('number');
    expect(bobRow.followers).toBeGreaterThanOrEqual(1); // alice follows bob
    expect('accuracy_percent' in bobRow).toBe(true); // null is fine (no resolved predictions)

    // Viewer-relative: alice follows bob (true) but not carol (false).
    expect(bobRow.is_following).toBe(true);
    expect(carolRow.is_following).toBe(false);
  });

  test('following list reports is_following true for the owner viewing their own follows', async () => {
    const dave = await createUser('fdave');
    const erin = await createUser('ferin');
    cleanup.userIds.push(dave.id, erin.id);

    await follow(erin.id, dave.token); // dave follows erin

    const res = await request(app)
      .get(`/api/users/${dave.id}/following`)
      .set('Authorization', `Bearer ${dave.token}`);

    expect(res.statusCode).toBe(200);
    const erinRow = res.body.find((r) => r.id === erin.id);
    expect(erinRow).toBeTruthy();
    expect(erinRow.is_following).toBe(true);
    expect(typeof erinRow.followers).toBe('number');
    expect('accuracy_percent' in erinRow).toBe(true);
  });
});
