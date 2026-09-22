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
test('defaults to Opus without requiring a personal API key', async () => {
  expect(await call(0)).toMatchObject({ status: 200, body: { model: 'anthropic/claude-opus-5.5' } });
});
test('the authenticated owner controls their setting, not the supplied user id', async () => {
  expect(await call(0, { model: 'off', userId: users[1] })).toMatchObject({ status: 200, body: { model: 'off' } });
  expect((await call(1)).body.model).toBe(settings.DEFAULT_MODEL);
  expect((await call(0, { model: 'openai/gpt-6-luna' })).body.model).toBe('openai/gpt-6-luna');
});
test('rejects arbitrary models and requires authentication', async () => {
  expect((await call(0, { model: 'expensive/unapproved' })).status).toBe(400);
  expect((await call(0)).body.model).toBe('openai/gpt-6-luna');
  expect((await call(99)).status).toBe(401);
});
test('post selection uses the author preference and excludes hidden posts', async () => {
  const id = (await db.query("INSERT INTO posts (user_id,content) VALUES ($1,'A prediction') RETURNING id", [users[0]])).rows[0].id;
  try {
    expect(await settings.forPost(id)).toBe('openai/gpt-6-luna');
    await settings.saveSettings(users[0], 'off');
    expect(await settings.forPost(id)).toBe('off');
    await settings.saveSettings(users[0], settings.DEFAULT_MODEL);
    await db.query('UPDATE posts SET is_hidden=TRUE WHERE id=$1', [id]);
    expect(await settings.forPost(id)).toBe('off');
  } finally { await db.query('DELETE FROM posts WHERE id=$1', [id]); }
});
