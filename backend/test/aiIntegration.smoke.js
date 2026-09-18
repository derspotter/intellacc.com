// Run explicitly against a disposable schema copy named ai_test. No live AI.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const db = require('../src/db');
const settings = require('../src/services/ai/aiSettingsService');
const conversations = require('../src/services/ai/aiConversationService');
const publicReplies = require('../src/services/ai/aiPublicReplyService');
const providers = require('../src/services/ai/providers');
const notifications = require('../src/services/notificationService');

async function main() {
  const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
  assert.equal(database, 'ai_test', 'This script must only run on the disposable ai_test database');
  process.env.AI_CREDENTIAL_SECRET = randomBytes(32).toString('base64');
  notifications.createReplyNotification = async () => {};
  notifications.createCommentNotification = async () => {};
  const suffix = randomBytes(4).toString('hex');
  const users = [];
  for (const name of ['owner', 'other']) {
    const row = (await db.query(
      `INSERT INTO users (username, email, password_hash, is_approved) VALUES ($1, $2, '!test-no-login', TRUE) RETURNING id`,
      [`aitest_${name}_${suffix}`, `aitest_${name}_${suffix}@example.invalid`]
    )).rows[0];
    users.push(row.id);
  }
  const [owner, other] = users;
  await settings.saveSettings(owner, { provider: 'openrouter', model: 'test/model', apiKey: 'fake-owner-only-key', publicReplies: true });
  await settings.saveSettings(other, { provider: 'anthropic', model: 'test-other', apiKey: 'fake-other-only-key', publicReplies: true });
  assert.equal((await settings.getSettings(owner)).configured, true);
  assert(!JSON.stringify(await settings.getSettings(owner)).includes('fake-owner-only-key'));
  await assert.rejects(settings.saveSettings(owner, { provider: 'xai', model: 'test', publicReplies: true }), /apiKey is required/);
  const calls = [];
  const complete = async (input) => { calls.push(input); return { text: 'Synthetic answer', model: input.model }; };
  const conv = await conversations.createConversation(owner);
  assert.equal(await conversations.getConversation(other, conv.id), null);
  assert.equal(await conversations.deleteConversation(other, conv.id), 'not_found');
  await assert.rejects(conversations.sendMessage(other, conv.id, { message: 'stolen', requestId: randomUUID() }, { complete }), e => e.status === 404);
  const request = { message: 'PRIVATE CANARY', requestId: randomUUID() };
  const first = await conversations.sendMessage(owner, conv.id, request, { complete });
  const replay = await conversations.sendMessage(owner, conv.id, request, { complete });
  assert.deepEqual(replay.messages.map(m => m.id), first.messages.map(m => m.id));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiKey, 'fake-owner-only-key');

  let release;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const held = conversations.sendMessage(owner, conv.id, { message: 'hold', requestId: randomUUID() }, {
    complete: async () => { began(); await new Promise(resolve => { release = resolve; }); return { text: 'Done', model: 'test/model' }; }
  });
  await started;
  await assert.rejects(conversations.sendMessage(owner, conv.id, { message: 'parallel', requestId: randomUUID() }, { complete }), e => e.code === 'busy');
  assert.equal(await conversations.deleteConversation(owner, conv.id), 'busy');
  release(); await held;
  const failedRequest = { message: 'timeout', requestId: randomUUID() };
  let failures = 0;
  const failing = async () => { failures++; throw new providers.AiProviderError('timeout', 'Timed out'); };
  await assert.rejects(conversations.sendMessage(owner, conv.id, failedRequest, { complete: failing }), e => e.code === 'timeout');
  await assert.rejects(conversations.sendMessage(owner, conv.id, failedRequest, { complete: failing }), e => e.code === 'request_failed');
  assert.equal(failures, 1);

  // Connection tests share the concurrency budget with ordinary generation.
  let startedTests = 0;
  let testsReady;
  const allTestsStarted = new Promise(resolve => { testsReady = resolve; });
  const testReleases = [];
  const heldTest = async () => {
    startedTests++;
    if (startedTests === 2) testsReady();
    await new Promise(resolve => testReleases.push(resolve));
    return { text: 'OK', model: 'test/model' };
  };
  const testOne = conversations.testSettings(owner, { complete: heldTest });
  const testTwo = conversations.testSettings(owner, { complete: heldTest });
  await allTestsStarted;
  await assert.rejects(conversations.testSettings(owner, { complete }), e => e.code === 'too_many_active');
  testReleases.forEach(resolve => resolve());
  await Promise.all([testOne, testTwo]);

  const addPost = async (userId, content, parent = null) => (await db.query(
    `INSERT INTO posts (user_id, content, parent_id, is_comment, depth) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, content, parent?.id || null, Boolean(parent), parent ? parent.depth + 1 : 0]
  )).rows[0];
  const root = await addPost(other, 'Public background');
  const trigger = await addPost(owner, '@ai explain this', root);
  const job = { postId: trigger.id, userId: owner, content: trigger.content, isBot: false };
  assert.equal((await publicReplies.enqueueForPost(job)).queued, true);
  assert.equal((await publicReplies.enqueueForPost(job)).queued, false);
  const worker = publicReplies.createPublicReplyWorker({ complete });
  await worker.runOnce();
  const status = await publicReplies.getStatus(owner, trigger.id);
  assert.equal(status.status, 'published');
  assert.equal(await publicReplies.getStatus(other, trigger.id), null);
  const reply = (await db.query('SELECT * FROM posts WHERE id = $1', [status.replyPostId])).rows[0];
  assert.equal(reply.parent_id, trigger.id);
  assert.equal(reply.is_bot, true);
  assert.notEqual(reply.user_id, owner);
  assert.equal((await db.query('SELECT comment_count FROM posts WHERE id = $1', [trigger.id])).rows[0].comment_count, 1);
  const publicCall = calls.at(-1);
  assert.equal(publicCall.apiKey, 'fake-owner-only-key');
  assert(!JSON.stringify(publicCall).includes('PRIVATE CANARY'));
  assert(JSON.stringify(publicCall).includes('Public background'));
  const count = calls.length;
  await worker.runOnce();
  assert.equal(calls.length, count);

  // Group privacy is inherited through ancestors, not just a leaf's group_id.
  const topic = (await db.query('INSERT INTO topics (name, slug) VALUES ($1, $2) RETURNING id', [`AI test ${suffix}`, `ai-test-${suffix}`])).rows[0];
  const group = (await db.query(
    'INSERT INTO community_groups (slug, name, topic_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [`ai-test-${suffix}`, 'Test group', topic.id, other]
  )).rows[0];
  let groupPost = await addPost(other, 'Private group context');
  await db.query('UPDATE posts SET community_group_id = $2 WHERE id = $1', [groupPost.id, group.id]);
  for (let i = 0; i < 12; i++) groupPost = await addPost(owner, i === 11 ? '@ai no group leak' : 'nested group reply', groupPost);
  await assert.rejects(conversations.createConversation(owner, { postId: groupPost.id }), e => e.status === 404);
  await publicReplies.enqueueForPost({ ...job, postId: groupPost.id, content: groupPost.content });
  await worker.runOnce();
  assert.equal((await publicReplies.getStatus(owner, groupPost.id)).errorCode, 'group_unsupported');
  assert.equal(calls.length, count);
  assert.equal(await publicReplies.enqueueForPost({ ...job, isBot: true }), null);

  // Hidden roots beyond the prompt limit still make a deep thread ineligible.
  let deep = await addPost(other, 'hidden root');
  const hiddenRoot = deep.id;
  for (let i = 0; i < 12; i++) deep = await addPost(owner, i === 11 ? '@ai must not run' : 'nested', deep);
  await db.query('UPDATE posts SET is_hidden = TRUE WHERE id = $1', [hiddenRoot]);
  await assert.rejects(conversations.createConversation(owner, { postId: deep.id }), e => e.status === 404);
  await publicReplies.enqueueForPost({ ...job, postId: deep.id, content: deep.content });
  await worker.runOnce();
  assert.equal((await publicReplies.getStatus(owner, deep.id)).status, 'failed');
  assert.equal(calls.length, count);

  // Deleting or hiding an ancestor during generation cannot publish its context.
  const changingRoot = await addPost(other, 'root becomes hidden');
  const changing = await addPost(owner, '@ai answer', changingRoot);
  await publicReplies.enqueueForPost({ ...job, postId: changing.id, content: changing.content });
  const changingWorker = publicReplies.createPublicReplyWorker({ complete: async () => {
    await db.query('UPDATE posts SET is_hidden = TRUE WHERE id = $1', [changingRoot.id]);
    return { text: 'Must not publish', model: 'test/model' };
  } });
  await changingWorker.runOnce();
  assert.equal((await publicReplies.getStatus(owner, changing.id)).status, 'failed');

  // AI routes reject agent keys and enforce history ownership at HTTP level.
  const express = require('express');
  const supertest = require('supertest');
  const { rejectAgentKeys } = require('../src/middleware/agentGuard');
  const app = express();
  app.use(express.json());
  app.use('/ai', (req, res, next) => { req.user = { id: Number(req.get('X-Test-User')) || owner, isAgent: req.get('X-Test-Agent') === 'yes' }; next(); }, rejectAgentKeys, require('../src/routes/ai'));
  await supertest(app).get('/ai/settings').set('X-Test-Agent', 'yes').expect(403);
  await supertest(app).post(`/ai/conversations/${conv.id}/messages`).set('X-Test-Agent', 'yes').send(request).expect(403);
  await supertest(app).get(`/ai/conversations/${conv.id}`).set('X-Test-User', String(other)).expect(404);
  await supertest(app).get(`/ai/conversations/${conv.id}junk`).expect(404);
  await supertest(app).get('/ai/settings').expect(200).then(res => assert(!JSON.stringify(res.body).includes('fake-owner-only-key')));
  assert.equal(await conversations.deleteConversation(owner, conv.id), 'deleted');
  assert.equal(await conversations.getConversation(owner, conv.id), null);
  console.log('AI integration smoke passed: schema, credentials, ownership, replay, concurrency, public worker, hidden ancestry, HTTP guards.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.closePool());
