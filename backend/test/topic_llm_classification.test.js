// backend/test/topic_llm_classification.test.js
// LLM-based topic classification with embedding fallback. The DB is real;
// only the OpenRouter LLM client is mocked.
process.env.TOPIC_CLASSIFIER_RETRY_MS = '1'; // keep rate-limit retry backoff near-instant in tests
jest.mock('../src/services/openRouterMatcher/llmClient');

const db = require('../src/db');
const { callLLM } = require('../src/services/openRouterMatcher/llmClient');
const topicService = require('../src/services/topicService');

jest.setTimeout(30000);

const vec = (hotIndex) => {
  const v = new Array(768).fill(0);
  v[hotIndex] = 1;
  return `[${v.join(',')}]`;
};

describe('topicService.classifyEventLLM', () => {
  const cleanup = { topicIds: [], eventIds: [] };

  afterAll(async () => {
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
  });

  beforeEach(() => {
    callLLM.mockReset();
  });

  const insertEvent = async (embedding = null) => {
    const result = embedding
      ? await db.query(
          `INSERT INTO events (title, closing_date, embedding) VALUES ('llm classify me', NOW() + INTERVAL '30 days', $1::vector) RETURNING id`,
          [embedding]
        )
      : await db.query(
          `INSERT INTO events (title, closing_date) VALUES ('llm classify me', NOW() + INTERVAL '30 days') RETURNING id`
        );
    cleanup.eventIds.push(result.rows[0].id);
    return result.rows[0].id;
  };

  const insertSyntheticTopic = async () => {
    const result = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing, embedding)
       VALUES ('LlmTestTopic' || floor(random()*1e9), 'llm-test-topic-' || floor(random()*1e9), TRUE, $1::vector)
       RETURNING id`,
      [vec(0)]
    );
    cleanup.topicIds.push(result.rows[0].id);
    return result.rows[0].id;
  };

  test('writes llm-sourced rows for valid slugs and replaces embedding rows', async () => {
    const eventId = await insertEvent();

    // Pre-existing embedding classification that must be replaced.
    const seeded = await db.query(`SELECT id FROM topics WHERE slug = 'sports'`);
    await db.query(
      `INSERT INTO event_topics (event_id, topic_id, similarity, source) VALUES ($1, $2, 0.9, 'embedding')`,
      [eventId, seeded.rows[0].id]
    );

    callLLM.mockResolvedValue({
      output: { topics: ['science', 'ai-technology'] },
      usage: {},
      requestedModel: 'mock',
      usedModel: 'mock',
      providerResponseId: null
    });

    const assigned = await topicService.classifyEventLLM(eventId);
    expect(assigned).toHaveLength(2);
    expect(assigned.every((r) => Number.isInteger(r.topic_id))).toBe(true);

    const rows = await db.query(
      `SELECT et.topic_id, et.similarity, et.source, t.slug
       FROM event_topics et JOIN topics t ON t.id = et.topic_id
       WHERE et.event_id = $1 ORDER BY t.slug`,
      [eventId]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.slug).sort()).toEqual(['ai-technology', 'science']);
    expect(rows.rows.every((r) => r.source === 'llm')).toBe(true);
    expect(rows.rows.every((r) => r.similarity === null)).toBe(true);
  });

  test('falls back to embedding classification when LLM returns only invalid slugs', async () => {
    const topicId = await insertSyntheticTopic();
    const eventId = await insertEvent(vec(0));

    callLLM.mockResolvedValue({
      output: { topics: ['nonsense'] },
      usage: {},
      requestedModel: 'mock',
      usedModel: 'mock',
      providerResponseId: null
    });

    const assigned = await topicService.classifyEventLLM(eventId);
    expect(assigned.map((r) => r.topic_id)).toContain(topicId);

    const rows = await db.query('SELECT topic_id, source FROM event_topics WHERE event_id = $1', [eventId]);
    expect(rows.rows.map((r) => r.topic_id)).toContain(topicId);
    expect(rows.rows.every((r) => r.source === 'embedding')).toBe(true);
  });

  test('falls back to embedding classification when the LLM call throws', async () => {
    const topicId = await insertSyntheticTopic();
    const eventId = await insertEvent(vec(0));

    callLLM.mockRejectedValue(new Error('network down'));

    const assigned = await topicService.classifyEventLLM(eventId);
    expect(assigned.map((r) => r.topic_id)).toContain(topicId);

    const rows = await db.query('SELECT topic_id, source FROM event_topics WHERE event_id = $1', [eventId]);
    expect(rows.rows.map((r) => r.topic_id)).toContain(topicId);
    expect(rows.rows.every((r) => r.source === 'embedding')).toBe(true);
  });

  test('returns [] without throwing for event with no embedding and failing LLM', async () => {
    const eventId = await insertEvent();

    callLLM.mockRejectedValue(new Error('network down'));

    const assigned = await topicService.classifyEventLLM(eventId);
    expect(assigned).toEqual([]);
  });

  test('retries on rate-limit (429) then succeeds with llm rows', async () => {
    const eventId = await insertEvent();

    callLLM
      .mockRejectedValueOnce(new Error('OpenRouter API 429: rate-limited'))
      .mockResolvedValueOnce({ output: { topics: ['science'] }, usage: {}, requestedModel: 'mock', usedModel: 'mock', providerResponseId: null });

    const assigned = await topicService.classifyEventLLM(eventId);
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(assigned).toHaveLength(1);

    const rows = await db.query('SELECT source FROM event_topics WHERE event_id = $1', [eventId]);
    expect(rows.rows.every((r) => r.source === 'llm')).toBe(true);
  });

  test('falls back to embedding after exhausting rate-limit retries', async () => {
    const topicId = await insertSyntheticTopic();
    const eventId = await insertEvent(vec(0));

    callLLM.mockRejectedValue(new Error('OpenRouter API 429: rate-limited'));

    const assigned = await topicService.classifyEventLLM(eventId);
    // 1 initial attempt + RATE_LIMIT_RETRIES (3) = 4 calls
    expect(callLLM).toHaveBeenCalledTimes(4);
    expect(assigned.map((r) => r.topic_id)).toContain(topicId);

    const rows = await db.query('SELECT source FROM event_topics WHERE event_id = $1', [eventId]);
    expect(rows.rows.every((r) => r.source === 'embedding')).toBe(true);
  });
});
