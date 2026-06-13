const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const weeklyAssignmentService = require('../src/services/weeklyAssignmentService');

jest.setTimeout(60000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: row.rows[0].id, username, token: loginRes.body.token };
};

describe('Topic-aware weekly assignment', () => {
  const cleanup = { userIds: [], eventIds: [], topicIds: [] };
  let user, topicId, inTopicEvent;

  beforeAll(async () => {
    user = await createUser('weeklyuser');
    cleanup.userIds.push(user.id);

    const t = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing) VALUES ('WeeklyTest' || floor(random()*1e9), 'weekly-test-' || floor(random()*1e9), TRUE) RETURNING id`
    );
    topicId = t.rows[0].id;
    cleanup.topicIds.push(topicId);

    const pad = await db.query(`SELECT id FROM topics WHERE is_user_facing AND id <> $1 LIMIT 2`, [topicId]);
    await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`)
      .send({ topicIds: [topicId, ...pad.rows.map((r) => r.id)] });
    // Narrow to ONLY the test topic so selection is deterministic:
    await db.query('DELETE FROM user_topics WHERE user_id = $1 AND topic_id <> $2', [user.id, topicId]);

    const mk = async (title) => {
      const ev = await db.query(
        `INSERT INTO events (title, closing_date, market_prob) VALUES ($1, NOW() + INTERVAL '30 days', 0.5) RETURNING id`, [title]
      );
      cleanup.eventIds.push(ev.rows[0].id);
      return ev.rows[0].id;
    };
    inTopicEvent = await mk('weekly in-topic event');
    const offTopicEvent = await mk('weekly off-topic event');
    await db.query(`INSERT INTO event_topics (event_id, topic_id, source) VALUES ($1, $2, 'test')`, [inTopicEvent, topicId]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM weekly_user_assignments WHERE user_id = ANY($1::int[])', [cleanup.userIds]);
    // Clear the users.weekly_assigned_event_id FK before deleting the events it may point at.
    if (cleanup.eventIds.length) await db.query('UPDATE users SET weekly_assigned_event_id = NULL WHERE weekly_assigned_event_id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('assigns onboarded user an event from their topics', async () => {
    const summary = await weeklyAssignmentService.assignWeeklyPredictions();
    expect(summary.assigned).toBeGreaterThanOrEqual(1);
    const row = await db.query(
      'SELECT event_id FROM weekly_user_assignments WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [user.id]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].event_id).toBe(inTopicEvent);
  });

  test('user without topics gets no assignment', async () => {
    const lurker = await createUser('weeklylurker');
    cleanup.userIds.push(lurker.id);
    await weeklyAssignmentService.assignWeeklyPredictions();
    const row = await db.query('SELECT 1 FROM weekly_user_assignments WHERE user_id = $1', [lurker.id]);
    expect(row.rows).toHaveLength(0);
  });
});
