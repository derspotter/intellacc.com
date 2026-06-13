const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: row.rows[0].id, username, token: loginRes.body.token };
};

const addResolvedPrediction = (userId, eventId, outcome) =>
  db.query(
    `INSERT INTO predictions (user_id, event_id, event, prediction_value, confidence, outcome, resolved_at)
     VALUES ($1, $2, 'test', 'yes', 60, $3, NOW())
     ON CONFLICT (user_id, event_id) DO UPDATE SET outcome = $3, resolved_at = NOW()`,
    [userId, eventId, outcome]
  );

describe('Discover API', () => {
  const cleanup = { userIds: [], eventIds: [], topicIds: [], postIds: [] };
  let viewer, ace, dud, topicId;

  beforeAll(async () => {
    viewer = await createUser('discviewer');
    ace = await createUser('discace');
    dud = await createUser('discdud');
    cleanup.userIds.push(viewer.id, ace.id, dud.id);

    const t = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing) VALUES ('DiscTest' || floor(random()*1e9), 'disc-test-' || floor(random()*1e9), TRUE) RETURNING id`
    );
    topicId = t.rows[0].id;
    cleanup.topicIds.push(topicId);

    const pad = await db.query(`SELECT id FROM topics WHERE is_user_facing AND id <> $1 LIMIT 2`, [topicId]);
    await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${viewer.token}`)
      .send({ topicIds: [topicId, ...pad.rows.map((r) => r.id)] });
    // Narrow to ONLY the test topic for deterministic ranking:
    await db.query('DELETE FROM user_topics WHERE user_id = $1 AND topic_id <> $2', [viewer.id, topicId]);

    for (let i = 0; i < 5; i++) {
      const ev = await db.query(
        `INSERT INTO events (title, closing_date, outcome) VALUES ('disc ev ' || $1, NOW() - INTERVAL '1 day', 'yes') RETURNING id`, [i]
      );
      const eventId = ev.rows[0].id;
      cleanup.eventIds.push(eventId);
      await db.query(`INSERT INTO event_topics (event_id, topic_id, source) VALUES ($1, $2, 'test')`, [eventId, topicId]);
      await addResolvedPrediction(ace.id, eventId, 'correct');
      await addResolvedPrediction(dud.id, eventId, i === 0 ? 'correct' : 'incorrect');
    }

    const post = await db.query(
      `INSERT INTO posts (user_id, content) VALUES ($1, 'ace says markets are great') RETURNING id`, [ace.id]
    );
    cleanup.postIds.push(post.rows[0].id);
  });

  afterAll(async () => {
    if (cleanup.postIds.length) await db.query('DELETE FROM posts WHERE id = ANY($1::int[])', [cleanup.postIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM predictions WHERE event_id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('predictors ranks in-topic accuracy, applies min-5 rule, excludes self', async () => {
    const res = await request(app).get('/api/discover/predictors').set('Authorization', `Bearer ${viewer.token}`);
    expect(res.statusCode).toBe(200);
    const ids = res.body.predictors.map((p) => p.id);
    expect(ids).toContain(ace.id);
    expect(ids).not.toContain(viewer.id);
    const aceRow = res.body.predictors.find((p) => p.id === ace.id);
    expect(Number(aceRow.accuracy_percent)).toBe(100);
    const dudRow = res.body.predictors.find((p) => p.id === dud.id);
    if (dudRow) expect(ids.indexOf(ace.id)).toBeLessThan(ids.indexOf(dud.id));
  });

  test('discover feed returns posts authored by top predictors', async () => {
    const res = await request(app).get('/api/discover/feed').set('Authorization', `Bearer ${viewer.token}`);
    expect(res.statusCode).toBe(200);
    const authors = res.body.items.map((p) => p.user_id);
    expect(authors).toContain(ace.id);
    const acePost = res.body.items.find((p) => p.user_id === ace.id);
    expect(acePost).toHaveProperty('username');
    expect(acePost).toHaveProperty('like_count');
  });

  test('requires auth', async () => {
    expect((await request(app).get('/api/discover/predictors')).statusCode).toBe(401);
    expect((await request(app).get('/api/discover/feed')).statusCode).toBe(401);
  });
});
