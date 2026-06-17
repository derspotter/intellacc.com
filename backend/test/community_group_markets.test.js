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
const mkEvent = async () => (await db.query(
  `INSERT INTO events (title, details, closing_date, event_type, category) VALUES ($1,'d',NOW()+INTERVAL '30 days','binary','test') RETURNING id`,
  [`Pin target ${Date.now()}_${Math.floor(Math.random()*1e6)}`])).rows[0].id;

describe('Community group markets', () => {
  const cleanup = { userIds: [], groupIds: [], eventIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('owner pins/unpins; non-owner 403; missing event 404; list returns pinned', async () => {
    const owner = await mkUser('gmowner', 2);
    const other = await mkUser('gmother', 2);
    cleanup.userIds.push(owner.id, other.id);
    const topicId = await firstTopic();
    const eventId = await mkEvent();
    cleanup.eventIds.push(eventId);
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Markets group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);

    const denied = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${other.token}`).send({ event_id: eventId });
    expect(denied.statusCode).toBe(403);
    const missing = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${owner.token}`).send({ event_id: 999999999 });
    expect(missing.statusCode).toBe(404);
    const pinned = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${owner.token}`).send({ event_id: eventId });
    expect(pinned.statusCode).toBe(200);
    const pinAgain = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${owner.token}`).send({ event_id: eventId });
    expect(pinAgain.statusCode).toBe(200);

    const list = await request(app).get(`/api/groups/${slug}/markets`);
    expect(list.statusCode).toBe(200);
    const m = list.body.markets.find((x) => x.event_id === eventId);
    expect(m).toBeTruthy();
    expect(m.title).toBeTruthy();

    const unpin = await request(app).delete(`/api/groups/${id}/markets/${eventId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(unpin.statusCode).toBe(200);
    const list2 = await request(app).get(`/api/groups/${slug}/markets`);
    expect(list2.body.markets.find((x) => x.event_id === eventId)).toBeFalsy();
  });
});
