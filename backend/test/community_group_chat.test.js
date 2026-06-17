const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
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

describe('Community group chat', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('member sends a message; non-member 403; empty 400; history is chronological', async () => {
    const owner = await mkUser('gcowner', 2);
    const stranger = await mkUser('gcstranger', 2);
    cleanup.userIds.push(owner.id, stranger.id);
    const topicId = await firstTopic();
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Chat group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);

    const m1 = await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${owner.token}`).send({ content: 'hello one' });
    expect(m1.statusCode).toBe(201);
    expect(m1.body.message.content).toBe('hello one');
    expect(m1.body.message.username).toBeTruthy();

    const denied = await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${stranger.token}`).send({ content: 'hi' });
    expect(denied.statusCode).toBe(403);

    const empty = await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${owner.token}`).send({ content: '   ' });
    expect(empty.statusCode).toBe(400);

    await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${owner.token}`).send({ content: 'hello two' });
    const hist = await request(app).get(`/api/groups/${slug}/messages`);
    expect(hist.statusCode).toBe(200);
    const texts = hist.body.messages.map((m) => m.content);
    expect(texts.slice(-2)).toEqual(['hello one', 'hello two']);
  });
});
