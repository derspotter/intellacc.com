const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const RESERVED_MESSAGE = 'This username is reserved';
const RESERVED_DISPLAY_NAME_MESSAGE = 'This display name is reserved';

const uniqueSuffix = () => `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

const registerUser = async ({ username, email }) => {
  return request(app)
    .post('/api/users/register')
    .send({
      username,
      email,
      password: 'testpass123'
    });
};

const createUser = async (label) => {
  const unique = uniqueSuffix();
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

describe('Reserved usernames', () => {
  const cleanup = [];

  afterAll(async () => {
    for (const entry of cleanup) {
      if (entry.userId) {
        await db.query('DELETE FROM users WHERE id = $1', [entry.userId]);
      }
      if (entry.email) {
        await db.query('DELETE FROM users WHERE email = $1', [entry.email]);
      }
    }
  });

  test('rejects registration with reserved username "guest"', async () => {
    const email = `guestreg_${uniqueSuffix()}@example.com`;
    cleanup.push({ email });

    const res = await registerUser({ username: 'guest', email });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe(RESERVED_MESSAGE);

    const rows = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(rows.rows.length).toBe(0);
  });

  test('rejects registration with mixed-case reserved username "GuEsT"', async () => {
    const email = `guestmixed_${uniqueSuffix()}@example.com`;
    cleanup.push({ email });

    const res = await registerUser({ username: 'GuEsT', email });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe(RESERVED_MESSAGE);
  });

  test('rejects registration with other reserved usernames', async () => {
    for (const reserved of ['Admin', 'ADMINISTRATOR', 'system', 'Moderator', 'mod', 'root', 'Support', 'Intellacc']) {
      const email = `reserved_${uniqueSuffix()}@example.com`;
      cleanup.push({ email });

      const res = await registerUser({ username: reserved, email });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe(RESERVED_MESSAGE);
    }
  });

  test('rejects username change to a reserved name', async () => {
    const user = await createUser('reschange');
    cleanup.push({ userId: user.id });

    const res = await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ username: 'GUEST' });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe(RESERVED_MESSAGE);

    const row = await db.query('SELECT username FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].username).toBe(user.username);
  });

  test('still allows registration with a normal username', async () => {
    const unique = uniqueSuffix();
    const email = `normalreg_${unique}@example.com`;
    cleanup.push({ email });

    const res = await registerUser({ username: `normaluser_${unique}`, email });

    expect(res.statusCode).toBe(201);
  });

  test('still allows username change to a normal name', async () => {
    const user = await createUser('normalchange');
    cleanup.push({ userId: user.id });

    const newUsername = `renamed_${uniqueSuffix()}`;
    const res = await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ username: newUsername });

    expect(res.statusCode).toBe(200);
    expect(res.body.username).toBe(newUsername);
  });

  test('rejects display name change to a reserved name', async () => {
    const user = await createUser('dispreserved');
    cleanup.push({ userId: user.id });

    for (const reserved of ['GUEST', 'Admin', '  system  ', 'Intellacc']) {
      const res = await request(app)
        .patch('/api/users/profile')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ display_name: reserved });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe(RESERVED_DISPLAY_NAME_MESSAGE);
    }

    const row = await db.query('SELECT display_name FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].display_name).toBeNull();
  });

  test('still allows a display name that merely contains a reserved word', async () => {
    const user = await createUser('dispcontains');
    cleanup.push({ userId: user.id });

    const res = await request(app)
      .patch('/api/users/profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ display_name: 'Admin Fan 2000' });

    expect(res.statusCode).toBe(200);
    expect(res.body.display_name).toBe('Admin Fan 2000');
  });

  test('registration ignores display_name (no reserved bypass at signup)', async () => {
    const unique = uniqueSuffix();
    const email = `dispreg_${unique}@example.com`;
    cleanup.push({ email });

    // createUser does not accept display_name; a smuggled reserved value
    // must not end up on the account.
    const res = await request(app)
      .post('/api/users/register')
      .send({
        username: `dispreg_${unique}`,
        email,
        password: 'testpass123',
        display_name: 'Admin'
      });

    expect(res.statusCode).toBe(201);

    const row = await db.query('SELECT display_name FROM users WHERE email = $1', [email]);
    expect(row.rows[0].display_name).toBeNull();
  });
});
