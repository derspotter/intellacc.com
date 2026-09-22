const { randomUUID } = require('crypto');
const db = require('../src/db');
const providers = require('../src/services/ai/providers');
const settings = require('../src/services/ai/aiSettingsService');
const preferences = require('../src/services/ai/postCritiqueSettings');
const service = require('../src/services/ai/postCritiqueService');
const { TEST_SECRET } = require('./ai_test_helpers');
jest.setTimeout(15000);
const users = [], posts = [];
const content = 'This candidate must win because three friends support her.';
const input = (index = 0) => ({ postId: posts[index], content, postContent: content });
let complete;
beforeAll(async () => {
  process.env.AI_CREDENTIAL_SECRET = TEST_SECRET;
  for (let i = 0; i < 2; i++) {
    const name = `byok_${randomUUID().slice(0, 8)}`;
    users.push((await db.query("INSERT INTO users (username,email,password_hash) VALUES ($1,$2,'test') RETURNING id", [name, `${name}@example.test`])).rows[0].id);
    posts.push((await db.query('INSERT INTO posts (user_id,content) VALUES ($1,$2) RETURNING id', [users[i], content])).rows[0].id);
  }
});
beforeEach(async () => {
  await db.query('DELETE FROM ai_post_critique_requests WHERE user_id=ANY($1::int[])', [users]);
  await db.query('DELETE FROM ai_usage_events WHERE user_id=ANY($1::int[])', [users]);
  await db.query('UPDATE posts SET is_hidden=FALSE,content=$2 WHERE id=ANY($1::int[])', [posts, content]);
  for (let i = 0; i < users.length; i++) {
    await settings.saveSettings(users[i], { provider: 'openrouter', model: `custom/model-${i}`, apiKey: `user-${i}-test-key-only`, publicReplies: false });
    await preferences.saveSettings(users[i], { model: '', enabled: true });
  }
  complete = jest.spyOn(providers, 'complete').mockImplementation(async ({ model }) => ({
    text: JSON.stringify({ critiques: [{ type: 'overgeneralization', description: 'Use a representative sample.' }] }), model
  }));
});
afterEach(() => complete.mockRestore());
afterAll(async () => {
  await db.query('DELETE FROM posts WHERE id=ANY($1::int[])', [posts]);
  await db.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]);
});
test('uses each author’s own key and unrestricted model, never the platform key', async () => {
  process.env.OPENROUTER_API_KEY = 'platform-key-not-for-critiques';
  for (let i = 0; i < 2; i++) {
    expect((await service.review(input(i))).critique_model).toBe(`custom/model-${i}`);
    expect(complete.mock.calls[i][0]).toMatchObject({ apiKey: `user-${i}-test-key-only`, model: `custom/model-${i}` });
  }
  expect((await db.query('SELECT count(*)::int AS n FROM ai_usage_events WHERE user_id=ANY($1::int[]) AND active_until IS NOT NULL', [users])).rows[0].n).toBe(0);
});
test('an arbitrary public model override uses the same owner credential', async () => {
  await preferences.saveSettings(users[0], { model: 'some-provider/new-model-xyz', enabled: true });
  await service.review(input());
  expect(complete.mock.calls[0][0]).toMatchObject({ apiKey: 'user-0-test-key-only', model: 'some-provider/new-model-xyz' });
});
test('missing key, opt-out, hidden post and superseded content make no provider request', async () => {
  await settings.deleteSettings(users[0]);
  expect(await service.review(input())).toBeNull();
  await preferences.saveSettings(users[1], { enabled: false });
  expect(await service.review(input(1))).toBeNull();
  await preferences.saveSettings(users[1], { enabled: true });
  await db.query('UPDATE posts SET is_hidden=TRUE WHERE id=$1', [posts[1]]);
  expect(await service.review(input(1))).toBeNull();
  await db.query('UPDATE posts SET is_hidden=FALSE,content=$2 WHERE id=$1', [posts[1], 'Edited post']);
  expect(await service.review(input(1))).toBeNull();
  expect(complete).not.toHaveBeenCalled();
});
test('replaying or concurrently requesting the same review cannot charge twice', async () => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  complete.mockImplementationOnce(async () => { enter(); await barrier; return { text: '{"critiques":[]}', model: 'custom/model-0' }; });
  const pending = service.review(input());
  try { await entered; expect(await service.review(input())).toBeNull(); }
  finally { release(); }
  const result = await pending;
  expect(await service.review(input())).toEqual(result);
  expect(complete).toHaveBeenCalledTimes(1);
});
test('provider failure never falls back to another key and retries do not spend again', async () => {
  complete.mockRejectedValue(new providers.AiProviderError('auth', 'Rejected key'));
  await expect(service.review(input())).rejects.toMatchObject({ code: 'auth' });
  expect(await service.review(input())).toBeNull();
  expect(complete).toHaveBeenCalledTimes(1);
});
test('shares the existing per-user request budget', async () => {
  await db.query("INSERT INTO ai_usage_events (user_id,kind) SELECT $1,'private' FROM generate_series(1,30)", [users[0]]);
  await expect(service.review(input())).rejects.toMatchObject({ code: 'rate_limited' });
  expect(complete).not.toHaveBeenCalled();
});
test('invalid feedback is rejected without a paid repair or invented critique', async () => {
  complete.mockResolvedValue({ text: '{"critiques":[{"type":"invented","description":"bad"}]}', model: 'custom/model-0' });
  await expect(service.review(input())).rejects.toMatchObject({ code: 'invalid_response' });
  expect(complete).toHaveBeenCalledTimes(1);
});
