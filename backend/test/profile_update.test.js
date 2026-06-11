const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  const userRow = await db.query('SELECT id FROM users WHERE email = $1', [email]);

  return {
    id: userRow.rows[0].id,
    email,
    username,
    password,
    token: loginRes.body.token
  };
};

describe('Profile updates', () => {
  const cleanup = [];

  afterAll(async () => {
    for (const entry of cleanup) {
      if (entry.userId) {
        await db.query('DELETE FROM users WHERE id = $1', [entry.userId]);
      }
    }
  });

  test('rejects empty username updates', async () => {
    const user = await createUser('emptyuser');
    cleanup.push({ userId: user.id });

    const res = await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ username: '   ' });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Username cannot be empty');
  });

  test('rejects duplicate username updates', async () => {
    const userA = await createUser('dupusera');
    const userB = await createUser('dupuserb');
    cleanup.push({ userId: userA.id });
    cleanup.push({ userId: userB.id });

    const res = await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ username: userA.username.toUpperCase() });

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('Username is already taken');
  });

  test('updates display name and profile visibility', async () => {
    const user = await createUser('displayname');
    cleanup.push({ userId: user.id });

    const res = await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ display_name: 'Display Name', profile_visibility: 'followers_only' });

    expect(res.statusCode).toBe(200);
    expect(res.body.display_name).toBe('Display Name');
    expect(res.body.profile_visibility).toBe('followers_only');
  });

  test('hides private profiles from other users', async () => {
    const owner = await createUser('privateowner');
    const viewer = await createUser('privateviewer');
    cleanup.push({ userId: owner.id });
    cleanup.push({ userId: viewer.id });

    await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ profile_visibility: 'private' })
      .expect(200);

    const res = await request(app)
      .get(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${viewer.token}`);

    expect(res.statusCode).toBe(404);
  });

  test('allows followers to view followers-only profiles', async () => {
    const owner = await createUser('followersowner');
    const viewer = await createUser('followersviewer');
    cleanup.push({ userId: owner.id });
    cleanup.push({ userId: viewer.id });

    await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ profile_visibility: 'followers_only', display_name: 'Visible To Followers' })
      .expect(200);

    await db.query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [viewer.id, owner.id]
    );

    const res = await request(app)
      .get(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${viewer.token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.display_name).toBe('Visible To Followers');
    expect(res.body.profile_visibility).toBe('followers_only');
    expect(res.body.email).toBeNull();
  });
});
