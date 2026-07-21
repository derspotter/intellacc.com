const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label, tier = 0) => {
  const unique = Date.now() + Math.floor(Math.random() * 100000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const login = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const id = row.rows[0].id;
  await db.query('UPDATE users SET verification_tier = $1 WHERE id = $2', [tier, id]);
  return { id, username, token: login.body.token };
};

const firstTopicId = async () => (await db.query('SELECT id FROM topics ORDER BY id LIMIT 1')).rows[0].id;

describe('Community groups — create/list/get', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('create requires tier >= 2; owner becomes member; list + get reflect it', async () => {
    const lowTier = await createUser('cglow', 1);
    const creator = await createUser('cgcreator', 2);
    cleanup.userIds.push(lowTier.id, creator.id);
    const topicId = await firstTopicId();

    const denied = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${lowTier.token}`)
      .send({ name: 'Tier1 group attempt', description: 'x', topic_id: topicId });
    expect(denied.statusCode).toBe(403);

    const created = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${creator.token}`)
      .send({ name: 'BTC 200k 2026 test', description: 'macro case', topic_id: topicId });
    expect(created.statusCode).toBe(201);
    expect(created.body.group.member_count).toBe(1);
    expect(created.body.group.is_member).toBe(true);
    expect(created.body.group.is_owner).toBe(true);
    expect(created.body.group.slug).toBeTruthy();
    cleanup.groupIds.push(created.body.group.id);

    const bad = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${creator.token}`)
      .send({ name: 'x', description: '', topic_id: topicId });
    expect(bad.statusCode).toBe(400);

    const list = await request(app).get('/api/groups').query({ topic: topicId })
      .set('Authorization', `Bearer ${creator.token}`);
    expect(list.statusCode).toBe(200);
    const found = list.body.groups.find((g) => g.id === created.body.group.id);
    expect(found).toBeTruthy();
    expect(found.is_member).toBe(true);
    expect(found.topic_name).toBeTruthy();

    const detail = await request(app).get(`/api/groups/${created.body.group.slug}`)
      .set('Authorization', `Bearer ${creator.token}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.group.is_owner).toBe(true);

    const missing = await request(app).get('/api/groups/does-not-exist-slug');
    expect(missing.statusCode).toBe(404);
  });

  test('join is idempotent and increments; leave decrements (floor 0)', async () => {
    const owner = await createUser('cgown', 2);
    const joiner = await createUser('cgjoin', 0);
    cleanup.userIds.push(owner.id, joiner.id);
    const topicId = await firstTopicId();
    const created = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Joinable group test', description: '', topic_id: topicId });
    const id = created.body.group.id;
    cleanup.groupIds.push(id);

    const join1 = await request(app).post(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${joiner.token}`);
    expect(join1.statusCode).toBe(200);
    expect(join1.body.is_member).toBe(true);
    expect(join1.body.member_count).toBe(2);

    const join2 = await request(app).post(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${joiner.token}`);
    expect(join2.body.member_count).toBe(2);

    const leave = await request(app).delete(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${joiner.token}`);
    expect(leave.statusCode).toBe(200);
    expect(leave.body.is_member).toBe(false);
    expect(leave.body.member_count).toBe(1);
  });

  test('search returns topic_name and viewer is_member; limit is parameterized (default 10, cap 20)', async () => {
    const owner = await createUser('cgsearch', 2);
    const outsider = await createUser('cgoutsider', 0);
    cleanup.userIds.push(owner.id, outsider.id);
    const topicId = await firstTopicId();
    const marker = `Quokka${Date.now()}`;

    const ids = [];
    for (let i = 0; i < 7; i++) {
      const created = await request(app).post('/api/groups')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: `${marker} group ${i}`, description: '', topic_id: topicId });
      expect(created.statusCode).toBe(201);
      ids.push(created.body.group.id);
    }
    cleanup.groupIds.push(...ids);

    const asOwner = await request(app).get('/api/groups/search')
      .query({ q: marker }).set('Authorization', `Bearer ${owner.token}`);
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.body.groups.length).toBe(7); // default limit 10, not hardcoded 5
    for (const g of asOwner.body.groups) {
      expect(g.topic_name).toBeTruthy();
      expect(g.is_member).toBe(true);
    }

    const asOutsider = await request(app).get('/api/groups/search')
      .query({ q: marker }).set('Authorization', `Bearer ${outsider.token}`);
    expect(asOutsider.body.groups.every((g) => g.is_member === false)).toBe(true);

    const anonymous = await request(app).get('/api/groups/search').query({ q: marker });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.body.groups.every((g) => g.is_member === false)).toBe(true);

    const limited = await request(app).get('/api/groups/search').query({ q: marker, limit: 3 });
    expect(limited.body.groups.length).toBe(3);
  });

  test('search matches by name; soft-delete only by owner/admin and then 404s', async () => {
    const owner = await createUser('cgdel', 2);
    const other = await createUser('cgother', 2);
    cleanup.userIds.push(owner.id, other.id);
    const topicId = await firstTopicId();
    const created = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Zebra Search Marker', description: '', topic_id: topicId });
    const { id, slug } = created.body.group;
    cleanup.groupIds.push(id);

    const search = await request(app).get('/api/groups/search').query({ q: 'Zebra Search' });
    expect(search.statusCode).toBe(200);
    expect(search.body.groups.some((g) => g.id === id)).toBe(true);

    const forbidden = await request(app).delete(`/api/groups/${id}`).set('Authorization', `Bearer ${other.token}`);
    expect(forbidden.statusCode).toBe(403);

    const removed = await request(app).delete(`/api/groups/${id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(removed.statusCode).toBe(200);

    const gone = await request(app).get(`/api/groups/${slug}`);
    expect(gone.statusCode).toBe(404);
  });
});
