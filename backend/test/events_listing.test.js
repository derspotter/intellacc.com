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
      // event_outcomes cascade-deletes with the event (ON DELETE CASCADE).
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    }
  });

  const insertEvent = async (title, { hidden = false, eventType = 'binary' } = {}) => {
    const result = await db.query(
      `INSERT INTO events (title, closing_date, hidden_at, hidden_reason, event_type)
       VALUES ($1, NOW() + INTERVAL '30 days', $2, $3, $4)
       RETURNING id`,
      [title, hidden ? new Date() : null, hidden ? 'llm: test junk' : null, eventType]
    );
    cleanup.eventIds.push(result.rows[0].id);
    return result.rows[0].id;
  };

  const insertOutcome = async (eventId, key, label, sortOrder = 0) => {
    await db.query(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES ($1, $2, $3, $4)`,
      [eventId, key, label, sortOrder]
    );
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

  test('unconfigured multiple_choice events (no outcomes) are excluded from the listing but reachable by id', async () => {
    const marker = Date.now();
    const unconfiguredId = await insertEvent(`mc unconfigured listing test ${marker}`, {
      eventType: 'multiple_choice'
    });
    const configuredId = await insertEvent(`mc configured listing test ${marker}`, {
      eventType: 'multiple_choice'
    });
    await insertOutcome(configuredId, 'choice_1', 'Alpha', 0);
    await insertOutcome(configuredId, 'choice_2', 'Beta', 1);

    const res = await request(app).get('/api/events').query({ search: 'listing test' });
    expect(res.statusCode).toBe(200);
    const ids = res.body.map((e) => e.id);
    expect(ids).not.toContain(unconfiguredId);
    expect(ids).toContain(configuredId);

    // By-id stays reachable for the unconfigured event (existing "not configured" UX).
    const byId = await request(app).get(`/api/events/${unconfiguredId}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.body.id).toBe(unconfiguredId);
  });

  test('a multiple_choice event with only one active outcome is still excluded (needs >= 2)', async () => {
    const marker = Date.now();
    const eventId = await insertEvent(`mc single outcome listing test ${marker}`, {
      eventType: 'multiple_choice'
    });
    await insertOutcome(eventId, 'choice_1', 'Only Option', 0);

    const res = await request(app).get('/api/events').query({ search: 'mc single outcome listing test' });
    expect(res.statusCode).toBe(200);
    const ids = res.body.map((e) => e.id);
    expect(ids).not.toContain(eventId);
  });

  test('unconfigured events are excluded from the paginated listing shape too', async () => {
    const marker = Date.now();
    const unconfiguredId = await insertEvent(`mc paginated unconfigured test ${marker}`, {
      eventType: 'multiple_choice'
    });

    const res = await request(app)
      .get('/api/events')
      .query({ search: 'mc paginated unconfigured test', limit: 10 });
    expect(res.statusCode).toBe(200);
    const ids = res.body.items.map((e) => e.id);
    expect(ids).not.toContain(unconfiguredId);
  });

  test('binary events with no outcomes remain listed (binary is exempt from the outcome predicate)', async () => {
    const eventId = await insertEvent(`binary no outcomes listing test ${Date.now()}`, {
      eventType: 'binary'
    });

    const res = await request(app).get('/api/events').query({ search: 'binary no outcomes listing test' });
    expect(res.statusCode).toBe(200);
    const ids = res.body.map((e) => e.id);
    expect(ids).toContain(eventId);
  });
});
