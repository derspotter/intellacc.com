const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const postController = require('../src/controllers/postController');
jest.setTimeout(30000);

const mkUser = async (label, tier = 0) => {
  const u = Date.now() + Math.floor(Math.random() * 100000);
  const email = `${label}_${u}@example.com`;
  await request(app).post('/api/users/register').send({ username: `${label}_${u}`, email, password: 'testpass123' });
  const login = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email=$1', [email]);
  await db.query('UPDATE users SET verification_tier=$1, email_verified_at=NOW() WHERE id=$2', [tier, row.rows[0].id]);
  return { id: row.rows[0].id, token: login.body.token };
};
const firstTopic = async () => (await db.query('SELECT id FROM topics ORDER BY id LIMIT 1')).rows[0].id;

const mkReq = (userId, body, io) => ({
  user: { id: userId },
  body,
  io,
  protocol: 'http',
  get: () => 'localhost:3000',
  headers: {}
});
const mkRes = () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return res;
};
const mkIo = () => {
  const io = { emit: jest.fn(), to: jest.fn() };
  io.to.mockReturnValue({ emit: jest.fn() });
  return io;
};

describe('Community group post socket broadcast', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('group post is not broadcast via global new_post', async () => {
    const owner = await mkUser('gbcast', 2);
    cleanup.userIds.push(owner.id);
    const topicId = await firstTopic();
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Broadcast leak test', description: '', topic_id: topicId });
    cleanup.groupIds.push(g.body.group.id);

    const io = mkIo();
    const res = mkRes();
    await postController.createPost(mkReq(owner.id, { content: 'private group post', community_group_id: g.body.group.id }, io), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const newPostCalls = io.emit.mock.calls.filter(([event]) => event === 'new_post');
    expect(newPostCalls).toHaveLength(0);
  });

  test('normal post is still broadcast via global new_post', async () => {
    const owner = await mkUser('gbcastnorm', 2);
    cleanup.userIds.push(owner.id);

    const io = mkIo();
    const res = mkRes();
    await postController.createPost(mkReq(owner.id, { content: 'public timeline post' }, io), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const newPostCalls = io.emit.mock.calls.filter(([event]) => event === 'new_post');
    expect(newPostCalls).toHaveLength(1);
    expect(newPostCalls[0][1].content).toBe('public timeline post');
  });

  test('io is resolved from app.get("io") — the wiring production uses', async () => {
    const owner = await mkUser('gbcastapp', 2);
    cleanup.userIds.push(owner.id);

    const io = mkIo();
    const res = mkRes();
    const req = mkReq(owner.id, { content: 'app-wired post' }, undefined);
    req.app = { get: (key) => (key === 'io' ? io : undefined) };
    await postController.createPost(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const newPostCalls = io.emit.mock.calls.filter(([event]) => event === 'new_post');
    expect(newPostCalls).toHaveLength(1);
  });
});
