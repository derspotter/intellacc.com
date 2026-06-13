const db = require('../db');
const { embedText } = require('./openRouterMatcher/embeddingService');
const { callLLM } = require('./openRouterMatcher/llmClient');

// A second topic is also assigned when its cosine similarity is within this
// margin of the best topic (events often straddle two topics).
const SECOND_TOPIC_MARGIN = 0.05;

const TOPIC_CLASSIFIER_MODEL = process.env.TOPIC_CLASSIFIER_MODEL || 'google/gemma-4-26b-a4b-it:free';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// OpenRouter free-tier models are intermittently rate-limited (429). Retry the
// classification call a few times with backoff before giving up to the fallback.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = Number(process.env.TOPIC_CLASSIFIER_RETRY_MS) || 3000;
const isRateLimit = (message) => message.includes('429') || message.toLowerCase().includes('rate');

const callClassifier = async (messages) => {
  let lastError;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await callLLM({
        model: TOPIC_CLASSIFIER_MODEL,
        messages,
        maxTokens: 100,
        temperature: 0,
        timeoutMs: 30000,
        usageContext: { stage: 'topic_classification', operation: 'chat_completion' }
      });
    } catch (error) {
      lastError = error;
      const message = error.message || String(error);
      if (!isRateLimit(message) || attempt === RATE_LIMIT_RETRIES) throw error;
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
    }
  }
  throw lastError;
};

const classificationPrompt = (title, details, slugs) => `You classify prediction-market questions into topics.
Allowed topic slugs: ${slugs.join(', ')}
Return exactly one JSON object: {"topics": ["slug", ...]} with 1-2 slugs, best first.
Question: ${JSON.stringify(String(title || '').slice(0, 300))}${details ? `\nDetails: ${JSON.stringify(String(details).slice(0, 500))}` : ''}`;

// callLLM already parses JSON output, but be defensive in case the mocked or
// raw content is a string (possibly wrapped in ```json fences).
const extractTopicSlugs = (output) => {
  let parsed = output;
  if (typeof parsed === 'string') {
    const cleaned = parsed.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  }
  if (!parsed || !Array.isArray(parsed.topics)) return [];
  return parsed.topics.filter((slug) => typeof slug === 'string');
};

// Generate embeddings for user-facing topics that don't have one yet.
const embedMissingTopicEmbeddings = async () => {
  const result = await db.query(
    `SELECT id, name, description FROM topics WHERE is_user_facing = TRUE AND embedding IS NULL`
  );
  let embedded = 0;
  for (const row of result.rows) {
    try {
      const embedding = await embedText(`${row.name}. ${row.description || ''}`);
      await db.query(`UPDATE topics SET embedding = $1::vector WHERE id = $2`, [
        `[${embedding.map(Number).join(',')}]`,
        row.id
      ]);
      embedded += 1;
    } catch (error) {
      console.error('[Topics] Embedding failed for topic', row.id, error.message);
    }
  }
  return embedded;
};

// Classify one event into 1-2 user-facing topics by embedding similarity.
// Replaces any previous 'embedding'-sourced rows; returns assigned rows.
const classifyEvent = async (eventId) => {
  const id = Number(eventId);
  if (!Number.isInteger(id)) throw new Error('Invalid event id');

  const result = await db.query(
    `WITH ranked AS (
       SELECT t.id AS topic_id,
              LEAST(1.0, GREATEST(-1.0, (1 - (e.embedding <=> t.embedding))))::REAL AS similarity,
              ROW_NUMBER() OVER (ORDER BY e.embedding <=> t.embedding ASC) AS rank
       FROM events e
       CROSS JOIN topics t
       WHERE e.id = $1
         AND e.embedding IS NOT NULL
         AND t.is_user_facing = TRUE
         AND t.embedding IS NOT NULL
     ),
     chosen AS (
       SELECT topic_id, similarity FROM ranked
       WHERE rank = 1
          OR (rank = 2 AND similarity >= (SELECT similarity FROM ranked WHERE rank = 1) - $2)
     ),
     cleared AS (
       DELETE FROM event_topics WHERE event_id = $1 AND source = 'embedding'
     )
     INSERT INTO event_topics (event_id, topic_id, similarity, source)
     SELECT $1, topic_id, similarity, 'embedding' FROM chosen
     ON CONFLICT (event_id, topic_id)
       DO UPDATE SET similarity = EXCLUDED.similarity, source = EXCLUDED.source
     RETURNING topic_id, similarity`,
    [id, SECOND_TOPIC_MARGIN]
  );
  return result.rows;
};

// Classify all events that have an embedding but no embedding-sourced topics.
const classifyUnclassifiedEvents = async () => {
  const result = await db.query(
    `SELECT e.id FROM events e
     WHERE e.embedding IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM event_topics et WHERE et.event_id = e.id AND et.source = 'embedding'
       )`
  );
  let classified = 0;
  for (const row of result.rows) {
    try {
      const assigned = await classifyEvent(row.id);
      if (assigned.length > 0) classified += 1;
    } catch (error) {
      console.error('[Topics] Classification failed for event', row.id, error.message);
    }
  }
  return classified;
};

// Classify one event into 1-2 user-facing topics via a (free-tier) LLM.
// On success it replaces ALL existing event_topics rows for the event with
// 'llm'-sourced ones; on any failure it falls back to embedding similarity.
const classifyEventLLM = async (eventId) => {
  const id = Number(eventId);
  if (!Number.isInteger(id)) throw new Error('Invalid event id');

  const eventResult = await db.query('SELECT title, details FROM events WHERE id = $1', [id]);
  if (eventResult.rows.length === 0) return [];
  const { title, details } = eventResult.rows[0];

  const topicsResult = await db.query(
    `SELECT id, slug FROM topics WHERE is_user_facing = TRUE AND slug IS NOT NULL ORDER BY display_order NULLS LAST, id`
  );
  const idBySlug = new Map(topicsResult.rows.map((t) => [t.slug, t.id]));

  let slugs = [];
  let failure = null;
  try {
    const result = await callClassifier(
      [{ role: 'user', content: classificationPrompt(title, details, [...idBySlug.keys()]) }]
    );
    slugs = extractTopicSlugs(result?.output).filter((slug) => idBySlug.has(slug)).slice(0, 2);
    if (slugs.length === 0) failure = 'no valid topic slugs in model output';
  } catch (error) {
    failure = error.message || String(error);
  }

  if (failure) {
    console.error('[Topics] LLM classification failed for event', id, failure);
    return classifyEvent(id);
  }

  const topicIds = slugs.map((slug) => idBySlug.get(slug));
  return db.executeWithTransaction(async (client) => {
    await client.query('DELETE FROM event_topics WHERE event_id = $1', [id]);
    const inserted = await client.query(
      `INSERT INTO event_topics (event_id, topic_id, similarity, source)
       SELECT $1, topic_id, NULL, 'llm' FROM UNNEST($2::int[]) AS topic_id
       RETURNING topic_id`,
      [id, topicIds]
    );
    return inserted.rows;
  });
};

// LLM-classify all events that don't have an 'llm'-sourced topic yet.
const classifyUnclassifiedEventsLLM = async () => {
  const result = await db.query(
    `SELECT e.id FROM events e
     WHERE NOT EXISTS (
       SELECT 1 FROM event_topics et WHERE et.event_id = e.id AND et.source = 'llm'
     )
     ORDER BY e.id`
  );
  // classifyEventLLM handles rate-limit retry/backoff and falls back to
  // embedding internally, so it should not throw; the catch is a safety net.
  let classified = 0;
  for (const row of result.rows) {
    try {
      const assigned = await classifyEventLLM(row.id);
      if (assigned.length > 0) classified += 1;
    } catch (error) {
      console.error('[Topics] LLM classification failed for event', row.id, error.message || String(error));
    }
  }
  return classified;
};

module.exports = {
  embedMissingTopicEmbeddings,
  classifyEvent,
  classifyUnclassifiedEvents,
  classifyEventLLM,
  classifyUnclassifiedEventsLLM,
  SECOND_TOPIC_MARGIN
};
