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

describe('Community group moderation', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) {
      await db.query('DELETE FROM moderation_reports WHERE reported_content_type = $1 AND reported_content_id = ANY($2::int[])', ['group', cleanup.groupIds]);
      await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    }
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('report group; remove post; kick member; members list', async () => {
    const owner = await mkUser('gmodowner', 2);
    const member = await mkUser('gmodmember', 2);
    cleanup.userIds.push(owner.id, member.id);
    const topicId = await firstTopic();
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Mod group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);
    await request(app).post(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${member.token}`);

    const ownReport = await request(app).post(`/api/groups/${id}/report`).set('Authorization', `Bearer ${owner.token}`).send({ reason: 'x' });
    expect(ownReport.statusCode).toBe(400);
    const report = await request(app).post(`/api/groups/${id}/report`).set('Authorization', `Bearer ${member.token}`).send({ reason: 'spam' });
    expect(report.statusCode).toBe(201);
    const rep = await db.query("SELECT * FROM moderation_reports WHERE reported_content_type='group' AND reported_content_id=$1", [id]);
    expect(rep.rows.length).toBe(1);

    const post = await request(app).post('/api/posts').set('Authorization', `Bearer ${member.token}`).send({ content: 'member post', community_group_id: id });
    const postId = post.body.id;
    const cantRemove = await request(app).delete(`/api/groups/${id}/posts/${postId}`).set('Authorization', `Bearer ${member.token}`);
    expect(cantRemove.statusCode).toBe(403);
    const removed = await request(app).delete(`/api/groups/${id}/posts/${postId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(removed.statusCode).toBe(200);
    const feed = await request(app).get(`/api/groups/${slug}/posts`);
    expect(feed.body.posts.find((p) => p.id === postId)).toBeFalsy();

    const members1 = await request(app).get(`/api/groups/${slug}/members`);
    expect(members1.body.members[0].role).toBe('owner');
    expect(members1.body.members.some((m) => m.user_id === member.id)).toBe(true);

    const cantKickOwner = await request(app).delete(`/api/groups/${id}/members/${owner.id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(cantKickOwner.statusCode).toBe(400);
    const kick = await request(app).delete(`/api/groups/${id}/members/${member.id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(kick.statusCode).toBe(200);
    expect(kick.body.member_count).toBe(1);
    const members2 = await request(app).get(`/api/groups/${slug}/members`);
    expect(members2.body.members.some((m) => m.user_id === member.id)).toBe(false);
  });
});
