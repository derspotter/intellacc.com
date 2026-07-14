// backend/test/events_listing.test.js
// GET /api/events: topic names are exposed per row for the category filter,
// and junk-flagged (hidden) events are excluded from the listing while staying
// reachable by id.
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

describe('GET /api/events listing', () => {
  const cleanup = { eventIds: [] };

  afterAll(async () => {
    if (cleanup.eventIds.length) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
  });

  const insertEvent = async (title, { hidden = false } = {}) => {
    const result = await db.query(
      `INSERT INTO events (title, closing_date, hidden_at, hidden_reason)
       VALUES ($1, NOW() + INTERVAL '30 days', $2, $3)
       RETURNING id`,
      [title, hidden ? new Date() : null, hidden ? 'llm: test junk' : null]
    );
    cleanup.eventIds.push(result.rows[0].id);
    return result.rows[0].id;
  };

  test('rows carry classified topic names in a topics array', async () => {
    const eventId = await insertEvent(`topics listing test ${Date.now()}`);
    const politics = await db.query(`SELECT id, name FROM topics WHERE slug = 'politics'`);
    await db.query(
      `INSERT INTO event_topics (event_id, topic_id, source) VALUES ($1, $2, 'llm')`,
      [eventId, politics.rows[0].id]
    );

    const res = await request(app).get('/api/events').query({ search: 'topics listing test' });
    expect(res.statusCode).toBe(200);
    const row = res.body.find((e) => e.id === eventId);
    expect(row).toBeDefined();
    expect(row.topics).toEqual([politics.rows[0].name]);
  });

  test('unclassified events carry an empty topics array', async () => {
    const eventId = await insertEvent(`untopiced listing test ${Date.now()}`);
    const res = await request(app).get('/api/events').query({ search: 'untopiced listing test' });
    expect(res.statusCode).toBe(200);
    const row = res.body.find((e) => e.id === eventId);
    expect(row.topics).toEqual([]);
  });

  test('hidden events are excluded from the listing but reachable by id', async () => {
    const visibleId = await insertEvent(`junkfilter listing test visible ${Date.now()}`);
    const hiddenId = await insertEvent(`junkfilter listing test hidden ${Date.now()}`, { hidden: true });

    const res = await request(app).get('/api/events').query({ search: 'junkfilter listing test' });
    expect(res.statusCode).toBe(200);
    const ids = res.body.map((e) => e.id);
    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(hiddenId);

    const byId = await request(app).get(`/api/events/${hiddenId}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.body.id).toBe(hiddenId);
  });

  test('GET /api/events/:id carries the same topics array as the listing', async () => {
    const eventId = await insertEvent(`topics byid test ${Date.now()}`);
    const politics = await db.query(`SELECT id, name FROM topics WHERE slug = 'politics'`);
    await db.query(
      `INSERT INTO event_topics (event_id, topic_id, source) VALUES ($1, $2, 'llm')`,
      [eventId, politics.rows[0].id]
    );

    const res = await request(app).get(`/api/events/${eventId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.topics).toEqual([politics.rows[0].name]);
  });

  test('GET /api/events/:id carries an empty topics array when unclassified', async () => {
    const eventId = await insertEvent(`untopiced byid test ${Date.now()}`);
    const res = await request(app).get(`/api/events/${eventId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.topics).toEqual([]);
  });
});
