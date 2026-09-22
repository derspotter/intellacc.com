const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../src/db');
const { getTestServer, releaseTestServer } = require('./testServer');
const settings = require('../src/services/ai/postCritiqueSettings');
jest.setTimeout(15000);
let baseUrl;
const users = [];
const tokens = [];
const call = async (index, body) => {
  const response = await fetch(`${baseUrl}/api/ai/critique-settings`, {
    method: body ? 'PUT' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(tokens[index] ? { Authorization: `Bearer ${tokens[index]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, body: await response.json() };
};
beforeAll(async () => {
  ({ baseUrl } = await getTestServer());
  for (let i = 0; i < 2; i++) {
    const name = `critique_${randomUUID().slice(0, 8)}`;
    const id = (await db.query("INSERT INTO users (username,email,password_hash) VALUES ($1,$2,'test') RETURNING id", [name, `${name}@example.test`])).rows[0].id;
    users.push(id); tokens.push(jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET));
  }
});
afterAll(async () => { await db.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]); await releaseTestServer(); });
test('defaults to disabled without a model or personal key', async () => {
  expect(await call(0)).toMatchObject({ status: 200, body: { model: '', enabled: false, configured: false } });
  expect((await call(0, { enabled: true, model: 'custom/anything' })).status).toBe(400);
});
test('any valid model can be saved without modifying another user', async () => {
  expect(await call(0, { enabled: false, model: 'custom/any-model-v999', userId: users[1] }))
    .toMatchObject({ status: 200, body: { model: 'custom/any-model-v999' } });
  expect((await call(1)).body).toMatchObject({ model: '', enabled: false });
});
test('rejects malformed model IDs and requires authentication', async () => {
  expect((await call(0, { enabled: false, model: 'invalid model' })).status).toBe(400);
  expect((await call(0, { model: 'custom/model' })).status).toBe(400);
  expect((await call(99)).status).toBe(401);
});
test('missing keys cannot use the platform key even if a preference is enabled', async () => {
  const id = (await db.query("INSERT INTO posts (user_id,content) VALUES ($1,'A prediction') RETURNING id", [users[0]])).rows[0].id;
  try {
    await db.query('UPDATE user_post_critique_settings SET enabled=TRUE WHERE user_id=$1', [users[0]]);
    expect(await settings.forPost(id)).toBeNull();
  } finally { await db.query('DELETE FROM posts WHERE id=$1', [id]); }
});
