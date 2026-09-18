// Private AI conversations over the real router: owner isolation, agent-key
// rejection, durable idempotency, per-conversation concurrency, failure
// status and budget. Database and provider are both faked.
jest.mock('../src/db', () => require('./ai_test_helpers').createFakeDb());

process.env.AI_CREDENTIAL_SECRET = require('./ai_test_helpers').TEST_SECRET;

const { randomUUID } = require('crypto');
const request = require('supertest');
const express = require('express');
const db = require('../src/db');
const providers = require('../src/services/ai/providers');
const { encryptCredential } = require('../src/services/ai/credentialCrypto');
const { rejectAgentKeys } = require('../src/middleware/agentGuard');
const { STALE_MS } = require('./ai_test_helpers');

const ALICE = 1;
const BOB = 2;
const KEY = 'sk-alice-secret-key-1234567890';

const app = express();
app.use(express.json());
app.use('/ai', (req, res, next) => {
  req.user = { id: Number(req.headers['x-user'] || ALICE), isAgent: req.headers['x-agent'] === '1' };
  next();
}, rejectAgentKeys, require('../src/routes/ai'));

const as = (user) => ({
  get: (url) => request(app).get(url).set('x-user', String(user)),
  post: (url) => request(app).post(url).set('x-user', String(user)),
  put: (url) => request(app).put(url).set('x-user', String(user)),
  delete: (url) => request(app).delete(url).set('x-user', String(user))
});
const send = (user, id, message, requestId = randomUUID()) =>
  as(user).post(`/ai/conversations/${id}/messages`).send({ message, requestId });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

let complete;
beforeEach(() => {
  process.env.AI_CREDENTIAL_SECRET = require('./ai_test_helpers').TEST_SECRET;
  for (const table of ['settings', 'conversations', 'messages', 'requests', 'posts', 'users']) db.state[table].clear();
  db.state.usage.length = 0; db.state.blocks.length = 0; db.state.members.length = 0; db.state.calls.length = 0;
  db.addUser({ id: ALICE, username: 'alice' });
  db.addUser({ id: BOB, username: 'bob' });
  db.state.settings.set(ALICE, { user_id: ALICE, provider: 'openai', model: 'gpt-test', key_ciphertext: encryptCredential(KEY, ALICE), key_hint: '…7890', public_replies: false });
  complete = jest.spyOn(providers, 'complete').mockResolvedValue({ text: 'Answer', model: 'gpt-test-2' });
});
afterEach(() => complete.mockRestore());

const newConversation = async (user = ALICE, body = {}) => {
  const res = await as(user).post('/ai/conversations').send(body);
  expect(res.status).toBe(201);
  return res.body.conversation;
};

describe('access control', () => {
  test('agent API keys are rejected on every AI route', async () => {
    for (const call of [
      request(app).get('/ai/settings'), request(app).put('/ai/settings'), request(app).post('/ai/test'),
      request(app).get('/ai/conversations'), request(app).post('/ai/conversations'), request(app).post('/ai/conversations/1/messages'),
      request(app).get('/ai/public-replies/1')
    ]) {
      const res = await call.set('x-user', String(ALICE)).set('x-agent', '1');
      expect(res.status).toBe(403);
    }
    expect(complete).not.toHaveBeenCalled();
  });

  test('settings responses carry a hint but no key material', async () => {
    const res = await as(ALICE).get('/ai/settings');
    expect(res.body).toEqual({ configured: true, provider: 'openai', model: 'gpt-test', keyHint: '…7890', publicReplies: false, available: true });
    expect(res.text).not.toContain(KEY);
    expect(res.text).not.toContain('v1.');
  });

  test('conversations are isolated per owner', async () => {
    const conv = await newConversation(ALICE);
    expect(conv).toEqual({ id: expect.any(Number), title: null, post_id: null });
    expect((await as(ALICE).get('/ai/conversations')).body.conversations.map((c) => c.id)).toEqual([conv.id]);
    expect((await as(BOB).get('/ai/conversations')).body.conversations).toEqual([]);
    expect((await as(BOB).get(`/ai/conversations/${conv.id}`)).status).toBe(404);
    expect((await as(BOB).delete(`/ai/conversations/${conv.id}`)).status).toBe(404);
    const stolen = await send(BOB, conv.id, 'hello');
    expect(stolen.status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
    expect((await as(ALICE).get(`/ai/conversations/${conv.id}`)).status).toBe(200);
    expect((await as(ALICE).delete(`/ai/conversations/${conv.id}`)).body).toEqual({ ok: true });
    expect((await as(ALICE).get(`/ai/conversations/${conv.id}`)).status).toBe(404);
  });

  test('post context requires the owner to be able to see the post', async () => {
    db.addPost({ id: 50, user_id: BOB, content: 'Visible post' });
    db.addPost({ id: 51, user_id: BOB, content: 'Hidden post', is_hidden: true });
    db.addPost({ id: 52, user_id: BOB, content: 'Group post', community_group_id: 9 });
    const conv = await newConversation(ALICE, { postId: 50 });
    expect(conv).toEqual({ id: expect.any(Number), title: 'Post by @bob', post_id: 50 });
    expect((await as(ALICE).post('/ai/conversations').send({ postId: 51 })).status).toBe(404);
    expect((await as(ALICE).post('/ai/conversations').send({ postId: 52 })).status).toBe(404);
    expect((await as(ALICE).post('/ai/conversations').send({ postId: 'abc' })).status).toBe(400);
    db.state.blocks.push({ blocker_id: BOB, blocked_user_id: ALICE });
    expect((await as(ALICE).post('/ai/conversations').send({ postId: 50 })).status).toBe(404);
  });
});

describe('sending messages', () => {
  test('persists both turns, replays on the same requestId and charges once', async () => {
    db.addPost({ id: 50, user_id: BOB, content: 'The post being discussed' });
    const conv = await newConversation(ALICE, { postId: 50 });
    const requestId = randomUUID();
    const first = await send(ALICE, conv.id, 'What is this about?', requestId);
    expect(first.status).toBe(200);
    expect(first.body.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'What is this about?', status: 'ok' }),
      expect.objectContaining({ role: 'assistant', content: 'Answer', model: 'gpt-test-2', status: 'ok' })
    ]);
    const call = complete.mock.calls[0][0];
    expect(call).toMatchObject({ provider: 'openai', model: 'gpt-test', apiKey: KEY });
    expect(call.system).toContain('The post being discussed');
    expect(call.system).toContain('cannot browse');
    expect(call.messages[call.messages.length - 1]).toEqual({ role: 'user', content: 'What is this about?' });

    const replay = await send(ALICE, conv.id, 'What is this about?', requestId);
    expect(replay.status).toBe(200);
    expect(replay.body.messages.map((m) => m.id)).toEqual(first.body.messages.map((m) => m.id));
    expect(complete).toHaveBeenCalledTimes(1);

    const loaded = await as(ALICE).get(`/ai/conversations/${conv.id}`);
    expect(loaded.body.conversation).toEqual({ id: conv.id, title: 'Post by @bob', post_id: 50 });
    expect(loaded.body.messages.map((m) => [m.role, m.content])).toEqual([['user', 'What is this about?'], ['assistant', 'Answer']]);
    expect((await as(ALICE).get('/ai/conversations')).body.conversations[0]).toMatchObject({ id: conv.id, title: 'Post by @bob' });
  });

  test('history is passed in order and bounded', async () => {
    const conv = await newConversation(ALICE);
    for (let i = 0; i < 15; i += 1) {
      const res = await send(ALICE, conv.id, `q${i}`);
      expect(res.status).toBe(200);
    }
    const turns = complete.mock.calls[14][0].messages;
    expect(turns.length).toBeLessThanOrEqual(21);
    expect(turns[turns.length - 1]).toEqual({ role: 'user', content: 'q14' });
    expect(turns[turns.length - 2]).toEqual({ role: 'assistant', content: 'Answer' });
    expect(turns[turns.length - 3]).toEqual({ role: 'user', content: 'q13' });
    expect((await as(ALICE).get('/ai/conversations')).body.conversations[0].title).toBe('q0');
  });

  test('a conversation is locked while generating: repeat, new request and delete are refused', async () => {
    const conv = await newConversation(ALICE);
    const pending = deferred();
    const started = deferred();
    complete.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const requestId = randomUUID();
    const inflight = send(ALICE, conv.id, 'slow question', requestId).then(result => result);
    await started.promise;
    expect((await send(ALICE, conv.id, 'slow question', requestId)).body).toMatchObject({ error: 'in_progress' });
    expect((await send(ALICE, conv.id, 'another question')).body).toMatchObject({ error: 'busy' });
    expect((await as(ALICE).delete(`/ai/conversations/${conv.id}`)).status).toBe(409);
    expect(complete).toHaveBeenCalledTimes(1);
    pending.resolve({ text: 'Late answer', model: 'gpt-test' });
    expect((await inflight).status).toBe(200);
    expect((await as(ALICE).delete(`/ai/conversations/${conv.id}`)).status).toBe(200);
  });

  test('provider failure is recorded, visible in history, and never retried on the same requestId', async () => {
    const conv = await newConversation(ALICE);
    complete.mockRejectedValueOnce(new providers.AiProviderError('auth', 'The provider rejected the API key'));
    const requestId = randomUUID();
    const failed = await send(ALICE, conv.id, 'hello', requestId);
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ error: 'auth', message: 'The provider rejected the API key' });
    const history = await as(ALICE).get(`/ai/conversations/${conv.id}`);
    expect(history.body.messages).toEqual([expect.objectContaining({ role: 'user', content: 'hello', status: 'failed', error_code: 'auth' })]);

    const repeat = await send(ALICE, conv.id, 'hello', requestId);
    expect(repeat.status).toBe(409);
    expect(repeat.body).toMatchObject({ error: 'request_failed', errorCode: 'auth' });
    expect(complete).toHaveBeenCalledTimes(1);

    const retry = await send(ALICE, conv.id, 'hello');
    expect(retry.status).toBe(200);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test('an ambiguous timeout is a failure, not an automatic retry', async () => {
    const conv = await newConversation(ALICE);
    complete.mockRejectedValueOnce(new providers.AiProviderError('timeout', 'The provider did not answer in time'));
    const res = await send(ALICE, conv.id, 'hello');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('timeout');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(db.state.conversations.get(conv.id).generation_request_id).toBeNull();
  });

  test('a crashed generation is marked interrupted and the conversation recovers', async () => {
    const conv = await newConversation(ALICE);
    const stale = randomUUID();
    const row = db.state.conversations.get(conv.id);
    row.generation_request_id = stale;
    row.generation_started_at = new Date(Date.now() - STALE_MS - 5000);
    db.state.requests.set(`${conv.id}:${stale}`, { conversation_id: conv.id, request_id: stale, status: 'running', user_message_id: null, assistant_message_id: null, error_code: null, updated_at: row.generation_started_at });
    const res = await send(ALICE, conv.id, 'are you there?');
    expect(res.status).toBe(200);
    expect(db.state.requests.get(`${conv.id}:${stale}`)).toMatchObject({ status: 'failed', error_code: 'interrupted' });
    expect((await send(ALICE, conv.id, 'x', stale)).body).toMatchObject({ error: 'request_failed', errorCode: 'interrupted' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('unconfigured users, bad input and exhausted budgets never reach the provider', async () => {
    const mine = await newConversation(ALICE);
    expect((await send(ALICE, mine.id, '')).status).toBe(400);
    expect((await send(ALICE, mine.id, 'x'.repeat(8001))).status).toBe(400);
    expect((await send(ALICE, mine.id, 'hi', 'not-a-uuid')).status).toBe(400);
    const theirs = await newConversation(BOB);
    const res = await send(BOB, theirs.id, 'hi');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_configured');
    for (let i = 0; i < 30; i += 1) db.state.usage.push({ id: i, user_id: ALICE, kind: 'private', at: Date.now() });
    const limited = await send(ALICE, mine.id, 'hi');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(complete).not.toHaveBeenCalled();
    expect((await as(ALICE).get(`/ai/conversations/${mine.id}`)).body.messages).toEqual([]);
  });
});

describe('settings test call', () => {
  test('uses the saved key with a tiny prompt and reports provider errors safely', async () => {
    const ok = await as(ALICE).post('/ai/test');
    expect(ok.body).toEqual({ ok: true });
    expect(complete.mock.calls[0][0]).toMatchObject({ provider: 'openai', model: 'gpt-test', apiKey: KEY, maxTokens: 16 });
    complete.mockRejectedValueOnce(new providers.AiProviderError('model_not_found', 'The provider does not know this model'));
    const bad = await as(ALICE).post('/ai/test');
    expect(bad.status).toBe(502);
    expect(bad.body).toEqual({ error: 'model_not_found', message: 'The provider does not know this model' });
    expect((await as(BOB).post('/ai/test')).body.error).toBe('not_configured');
  });
});
