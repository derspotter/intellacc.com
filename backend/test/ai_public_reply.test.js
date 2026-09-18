// Public @ai replies: trigger detection, key ownership, loop prevention,
// prompt limited to the visible public thread (never private history),
// durable one-shot jobs and at-most-once publication.
jest.mock('../src/db', () => require('./ai_test_helpers').createFakeDb());
jest.mock('../src/services/notificationService', () => ({
  createCommentNotification: jest.fn().mockResolvedValue(null),
  createReplyNotification: jest.fn().mockResolvedValue(null)
}));

process.env.AI_CREDENTIAL_SECRET = require('./ai_test_helpers').TEST_SECRET;

const db = require('../src/db');
const notificationService = require('../src/services/notificationService');
const providers = require('../src/services/ai/providers');
const { encryptCredential } = require('../src/services/ai/credentialCrypto');
const { mentionsAi } = require('../src/services/ai/aiMentionService');
const service = require('../src/services/ai/aiPublicReplyService');

const ALICE = 1;
const BOB = 2;
const BOT = 9;
const ALICE_KEY = 'sk-ant-alice-key-000000000000';
const BOB_KEY = 'sk-ant-bob-key-11111111111111';
const PRIVATE_SECRET = 'PRIVATE_DM_SECRET_TOKEN';

const io = { emit: jest.fn(), to: jest.fn(() => ({ emit: io.roomEmit })), roomEmit: jest.fn() };
let complete;
let worker;

const settingsRow = (userId, key, publicReplies, model = 'claude-test') => ({
  user_id: userId, provider: 'anthropic', model, key_ciphertext: encryptCredential(key, userId), key_hint: '…', public_replies: publicReplies
});

beforeEach(() => {
  process.env.AI_CREDENTIAL_SECRET = require('./ai_test_helpers').TEST_SECRET;
  for (const table of ['settings', 'conversations', 'messages', 'requests', 'posts', 'users', 'jobs']) db.state[table].clear();
  db.state.usage.length = 0; db.state.blocks.length = 0; db.state.members.length = 0; db.state.calls.length = 0;
  jest.clearAllMocks();
  service.resetBotCache();
  db.addUser({ id: ALICE, username: 'alice' });
  db.addUser({ id: BOB, username: 'bob' });
  db.addUser({ id: BOT, username: 'ai', system_bot_key: 'ai_assistant' });
  db.state.settings.set(ALICE, settingsRow(ALICE, ALICE_KEY, true));
  db.state.settings.set(BOB, settingsRow(BOB, BOB_KEY, true));
  db.addPost({ id: 100, user_id: BOB, content: 'Root question about markets' });
  db.addPost({ id: 101, user_id: ALICE, parent_id: 100, depth: 1, content: '@ai what do you think?' });
  // Private material that must never appear in a public prompt.
  db.state.conversations.set(500, { id: 500, user_id: ALICE, post_id: 100, title: 't', generation_request_id: null, generation_started_at: null, updated_at: new Date() });
  db.state.messages.set(501, { id: 501, conversation_id: 500, role: 'user', content: PRIVATE_SECRET, status: 'ok' });
  complete = jest.spyOn(providers, 'complete').mockResolvedValue({ text: 'Public answer', model: 'claude-test-2' });
  worker = service.createPublicReplyWorker({ io });
});
afterEach(() => { worker.stop(); complete.mockRestore(); });

const enqueue = (overrides = {}) => service.enqueueForPost({ postId: 101, userId: ALICE, content: '@ai what do you think?', isBot: false, repostId: null, communityGroupId: null, ...overrides });
const replies = () => [...db.state.posts.values()].filter((p) => p.user_id === BOT);

describe('mention detection', () => {
  test.each([
    ['@ai what is this?', true], ['Hey @ai', true], ['@AI please', true], ['(@ai)', true], ['ask @ai.', true], ['"@ai" summon', true], ['line\n@ai help', true],
    ['mail me at bob@ai.example', false], ['@ai.example is a domain', false], ['@ai_bot', false], ['@aiden hello', false], ['ai without at', false], ['email x@ai', false], ['', false], [null, false]
  ])('%j -> %s', (content, expected) => {
    expect(mentionsAi(content)).toBe(expected);
  });
});

describe('enqueueForPost', () => {
  test('ignores posts that do not summon, bot posts, reposts and the bot itself', async () => {
    expect(await enqueue({ content: 'no summon here' })).toBeNull();
    expect(await enqueue({ isBot: true })).toBeNull();
    expect(await enqueue({ repostId: 100 })).toBeNull();
    expect(await enqueue({ userId: BOT })).toBeNull();
    expect(db.state.jobs.size).toBe(0);
  });

  test('declines with a notice when setup is missing, and records why', async () => {
    db.state.settings.delete(ALICE);
    expect(await enqueue()).toEqual({ queued: false, notice: expect.stringMatching(/Add an AI provider key/) });
    expect(db.state.jobs.get(101)).toMatchObject({ status: 'declined', error_code: 'not_configured' });
    db.state.jobs.clear();
    db.state.settings.set(ALICE, settingsRow(ALICE, ALICE_KEY, false));
    expect(await enqueue()).toEqual({ queued: false, notice: expect.stringMatching(/turned off/) });
    db.state.jobs.clear();
    db.state.settings.set(ALICE, settingsRow(ALICE, ALICE_KEY, true, ''));
    expect((await enqueue()).notice).toMatch(/Set a model/);
    db.state.jobs.clear();
    db.state.settings.set(ALICE, settingsRow(ALICE, ALICE_KEY, true));
    expect((await enqueue({ communityGroupId: 7 })).notice).toMatch(/groups/);
    expect(db.state.jobs.get(101)).toMatchObject({ status: 'declined', error_code: 'group_unsupported' });
    db.state.jobs.clear();
    delete process.env.AI_CREDENTIAL_SECRET;
    expect((await enqueue()).notice).toMatch(/not available/);
    expect(complete).not.toHaveBeenCalled();
  });

  test('queues exactly one durable job per post and exposes status to the requester only', async () => {
    expect(await enqueue()).toEqual({ queued: true });
    expect(await enqueue()).toEqual({ queued: false });
    expect(db.state.jobs.size).toBe(1);
    expect(await service.getStatus(ALICE, 101)).toMatchObject({ status: 'queued', reason: null });
    expect(await service.getStatus(BOB, 101)).toBeNull();
  });
});

describe('worker', () => {
  test("publishes once with the requester's key, labelled, from public thread context only", async () => {
    await enqueue();
    await worker.runOnce();

    expect(complete).toHaveBeenCalledTimes(1);
    const call = complete.mock.calls[0][0];
    expect(call).toMatchObject({ provider: 'anthropic', model: 'claude-test', apiKey: ALICE_KEY });
    expect(call.apiKey).not.toBe(BOB_KEY);
    expect(call.system).toContain('@alice');
    expect(call.system).toContain('cannot browse');
    expect(call.messages).toHaveLength(1);
    const prompt = call.messages[0].content;
    expect(prompt.indexOf('Root question about markets')).toBeGreaterThan(-1);
    expect(prompt.indexOf('Root question about markets')).toBeLessThan(prompt.indexOf('@ai what do you think?'));
    expect(prompt).toContain('[@bob]');
    expect(prompt).toContain('[@alice (mentions @ai, reply to this one)]');
    expect(prompt).not.toContain(PRIVATE_SECRET);
    expect(call.system).not.toContain(PRIVATE_SECRET);
    // Private history tables are never read while building a public prompt.
    expect(db.sqlTouching('ai_messages')).toEqual([]);
    expect(db.state.calls.filter((c) => c.sql.includes('FROM ai_conversations WHERE id'))).toEqual([]);

    const [reply] = replies();
    expect(reply).toMatchObject({ user_id: BOT, parent_id: 101, depth: 2, is_comment: true, is_bot: true });
    expect(reply.content.startsWith('[AI reply · claude-test-2 · requested by @alice]')).toBe(true);
    expect(reply.content).toContain('Public answer');
    expect(db.state.posts.get(101).comment_count).toBe(1);
    expect(db.state.jobs.get(101)).toMatchObject({ status: 'published', reply_post_id: reply.id, model: 'claude-test-2', lease_id: null });
    expect(db.state.usage.filter((e) => e.user_id === ALICE && e.kind === 'public')).toHaveLength(1);
    expect(await service.getStatus(ALICE, 101)).toMatchObject({ status: 'published', replyPostId: reply.id });

    expect(notificationService.createReplyNotification).toHaveBeenCalledWith(BOT, 101, ALICE, reply.id);
    expect(notificationService.createCommentNotification).not.toHaveBeenCalled();
    expect(io.to).toHaveBeenCalledWith('post:101');
    expect(io.roomEmit).toHaveBeenCalledWith('new_comment', expect.objectContaining({ id: reply.id, username: 'ai' }));
    expect(io.to).toHaveBeenCalledWith(`user:${ALICE}`);
    expect(io.roomEmit).toHaveBeenCalledWith('ai_public_reply_status', expect.objectContaining({ post_id: 101, status: 'published', reply_post_id: reply.id }));
    expect(io.emit).not.toHaveBeenCalled();

    // A second pass does nothing: no re-generation, no second reply.
    await worker.runOnce();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(replies()).toHaveLength(1);
  });

  test('top-level trigger notifies as a comment on the post', async () => {
    db.addPost({ id: 102, user_id: ALICE, content: '@ai hello there' });
    await service.enqueueForPost({ postId: 102, userId: ALICE, content: '@ai hello there' });
    await worker.runOnce();
    const reply = replies()[0];
    expect(reply.parent_id).toBe(102);
    expect(notificationService.createCommentNotification).toHaveBeenCalledWith(BOT, 102, ALICE, reply.id);
  });

  test('the bot never summons itself, so replies cannot chain', async () => {
    await enqueue();
    await worker.runOnce();
    const [reply] = replies();
    expect(mentionsAi(reply.content)).toBe(false);
    expect(await service.enqueueForPost({ postId: reply.id, userId: BOT, content: `${reply.content} @ai`, isBot: true })).toBeNull();
    expect(await service.enqueueForPost({ postId: reply.id, userId: BOT, content: '@ai again', isBot: false })).toBeNull();
    expect(db.state.jobs.size).toBe(1);
  });

  test.each([
    ['hidden ancestor', () => { db.state.posts.get(100).is_hidden = true; }, 'post_unavailable'],
    ['blocked ancestor author', () => { db.state.blocks.push({ blocker_id: BOB, blocked_user_id: ALICE }); }, 'post_unavailable'],
    ['ancestor inside a group', () => { db.state.posts.get(100).community_group_id = 4; }, 'group_unsupported'],
    ['trigger authored by someone else', () => { db.state.posts.get(101).user_id = BOB; }, 'post_unavailable'],
    ['trigger edited to drop the summon', () => { db.state.posts.get(101).content = 'never mind'; }, 'post_unavailable'],
    ['key deleted after queueing', () => { db.state.settings.delete(ALICE); }, 'not_configured'],
    ['public replies disabled after queueing', () => { db.state.settings.set(ALICE, settingsRow(ALICE, ALICE_KEY, false)); }, 'public_replies_disabled']
  ])('%s fails the job before any paid request', async (_label, mutate, code) => {
    await enqueue();
    mutate();
    await worker.runOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(replies()).toHaveLength(0);
    expect(db.state.jobs.get(101)).toMatchObject({ status: 'failed', error_code: code });
    const status = await service.getStatus(ALICE, 101);
    expect(status.status).toBe('failed');
    expect(status.reason).toEqual(expect.any(String));
    expect(io.roomEmit).toHaveBeenCalledWith('ai_public_reply_status', expect.objectContaining({ post_id: 101, status: 'failed' }));
  });

  test('a post hidden during generation is never answered', async () => {
    await enqueue();
    complete.mockImplementationOnce(async () => { db.state.posts.get(101).is_hidden = true; return { text: 'late', model: 'm' }; });
    await worker.runOnce();
    expect(replies()).toHaveLength(0);
    expect(db.state.jobs.get(101)).toMatchObject({ status: 'failed', error_code: 'post_unavailable' });
  });

  test('provider failures end the job without retry and surface a reason', async () => {
    await enqueue();
    complete.mockRejectedValueOnce(new providers.AiProviderError('auth', 'rejected'));
    await worker.runOnce();
    await worker.runOnce();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(replies()).toHaveLength(0);
    expect(await service.getStatus(ALICE, 101)).toMatchObject({ status: 'failed', errorCode: 'auth', reason: expect.stringMatching(/rejected the API key/) });
  });

  test('an expired lease from a crashed worker is failed, not re-run', async () => {
    await enqueue();
    Object.assign(db.state.jobs.get(101), { status: 'running', lease_id: 'dead-lease', locked_until: new Date(Date.now() - 1000) });
    await worker.runOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(db.state.jobs.get(101)).toMatchObject({ status: 'failed', error_code: 'interrupted' });
    expect(io.roomEmit).toHaveBeenCalledWith('ai_public_reply_status', expect.objectContaining({ status: 'failed' }));
  });

  test('the durable budget covers public replies too', async () => {
    for (let i = 0; i < 30; i += 1) db.state.usage.push({ id: i, user_id: ALICE, kind: 'private', at: Date.now() });
    await enqueue();
    await worker.runOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(db.state.jobs.get(101)).toMatchObject({ status: 'failed', error_code: 'rate_limited' });
  });

  test('thread context is bounded to the nearest ancestors', async () => {
    let parent = 100;
    for (let i = 0; i < 12; i += 1) {
      db.addPost({ id: 200 + i, user_id: BOB, parent_id: parent, depth: i + 1, content: `Ancestor ${i}` });
      parent = 200 + i;
    }
    db.addPost({ id: 300, user_id: ALICE, parent_id: parent, depth: 13, content: '@ai summarize' });
    await service.enqueueForPost({ postId: 300, userId: ALICE, content: '@ai summarize' });
    await worker.runOnce();
    const prompt = complete.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Ancestor 11');
    expect(prompt).not.toContain('Ancestor 0\n');
    expect(prompt).not.toContain('Root question');
  });
});
