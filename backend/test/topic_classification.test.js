// backend/test/topic_classification.test.js
const db = require('../src/db');
const topicService = require('../src/services/topicService');

jest.setTimeout(30000);

const vec = (hotIndex) => {
  const v = new Array(768).fill(0);
  v[hotIndex] = 1;
  return `[${v.join(',')}]`;
};

describe('topicService.classifyEvent', () => {
  const cleanup = { topicIds: [], eventIds: [] };

  afterAll(async () => {
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
  });

  test('assigns the nearest user-facing topic; adds second only within margin', async () => {
    const t1 = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing, embedding) VALUES ('TestTopicA' || floor(random()*1e9), 'test-topic-a-' || floor(random()*1e9), TRUE, $1::vector) RETURNING id`,
      [vec(0)]
    );
    const t2 = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing, embedding) VALUES ('TestTopicB' || floor(random()*1e9), 'test-topic-b-' || floor(random()*1e9), TRUE, $1::vector) RETURNING id`,
      [vec(1)]
    );
    cleanup.topicIds.push(t1.rows[0].id, t2.rows[0].id);

    const ev = await db.query(
      `INSERT INTO events (title, closing_date, embedding) VALUES ('classify me', NOW() + INTERVAL '30 days', $1::vector) RETURNING id`,
      [vec(0)]
    );
    cleanup.eventIds.push(ev.rows[0].id);

    const assigned = await topicService.classifyEvent(ev.rows[0].id);
    expect(assigned.map((a) => a.topic_id)).toContain(t1.rows[0].id);
    expect(assigned.map((a) => a.topic_id)).not.toContain(t2.rows[0].id);

    const rows = await db.query('SELECT topic_id, source FROM event_topics WHERE event_id = $1', [ev.rows[0].id]);
    // The event is identical to t1's vector (similarity 1) and orthogonal to t2
    // and to the 10 seeded topics (which may have NULL embeddings still) — only t1 qualifies.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows.map((r) => r.topic_id)).toContain(t1.rows[0].id);
    expect(rows.rows.every((r) => r.source === 'embedding')).toBe(true);
  });

  test('returns empty array for event without embedding', async () => {
    const ev = await db.query(
      `INSERT INTO events (title, closing_date) VALUES ('no embedding', NOW() + INTERVAL '30 days') RETURNING id`
    );
    cleanup.eventIds.push(ev.rows[0].id);
    const assigned = await topicService.classifyEvent(ev.rows[0].id);
    expect(assigned).toEqual([]);
  });
});
