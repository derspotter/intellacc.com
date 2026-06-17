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

describe('Community group feed', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('member posts into a group; non-member 403; feed lists it', async () => {
    const owner = await mkUser('gfowner', 2);
    const stranger = await mkUser('gfstranger', 2);
    cleanup.userIds.push(owner.id, stranger.id);
    const topicId = await firstTopic();
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Feed group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);

    const posted = await request(app).post('/api/posts').set('Authorization', `Bearer ${owner.token}`)
      .send({ content: 'first group post', community_group_id: id });
    expect(posted.statusCode).toBe(201);
    expect(posted.body.community_group_id).toBe(id);

    const denied = await request(app).post('/api/posts').set('Authorization', `Bearer ${stranger.token}`)
      .send({ content: 'intruder', community_group_id: id });
    expect(denied.statusCode).toBe(403);

    const rejected = await request(app).post('/api/posts').set('Authorization', `Bearer ${owner.token}`)
      .send({ content: 'bad', community_group_id: id, parent_id: posted.body.id });
    expect(rejected.statusCode).toBe(400);

    const feed = await request(app).get(`/api/groups/${slug}/posts`).set('Authorization', `Bearer ${owner.token}`);
    expect(feed.statusCode).toBe(200);
    const row = feed.body.posts.find((p) => p.id === posted.body.id);
    expect(row).toBeTruthy();
    expect(row.username).toBeTruthy();
    expect(typeof row.like_count).toBe('number');
    expect('liked_by_user' in row).toBe(true);
  });
});
