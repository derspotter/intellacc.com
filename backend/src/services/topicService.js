const db = require('../db');
const { embedText } = require('./openRouterMatcher/embeddingService');
const { classifyWithGemma } = require('./gemmaClassifier');

// A second topic is also assigned when its cosine similarity is within this
// margin of the best topic (events often straddle two topics).
const SECOND_TOPIC_MARGIN = 0.05;

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

// Classify one event into 1-2 user-facing topics via the local LLM. The same
// call returns a junk verdict (unserious / match-betting markets) used to hide
// the event. On success it replaces ALL existing event_topics rows for the
// event with 'llm'-sourced ones; on any failure it falls back to embedding
// similarity. llm_checked_at is only stamped when BOTH topics and the junk
// verdict came back valid, so a partial answer is retried by the next sweep.
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
  let junk = null;
  let junkReason = null;
  let failure = null;
  try {
    const verdict = await classifyWithGemma(title, details, [...idBySlug.keys()]);
    slugs = (verdict.topics || []).filter((s) => idBySlug.has(s)).slice(0, 2);
    junk = verdict.junk;
    junkReason = verdict.junkReason;
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

    if (junk === true) {
      await client.query(
        `UPDATE events
         SET hidden_at = NOW(),
             hidden_reason = $2,
             llm_checked_at = NOW()
         WHERE id = $1`,
        [id, `llm: ${junkReason || 'junk market'}`]
      );
    } else if (junk === false) {
      // Clear only model-sourced hides; a manual hide (any other reason) stays.
      await client.query(
        `UPDATE events
         SET hidden_at = CASE WHEN hidden_reason LIKE 'llm:%' THEN NULL ELSE hidden_at END,
             hidden_reason = CASE WHEN hidden_reason LIKE 'llm:%' THEN NULL ELSE hidden_reason END,
             llm_checked_at = NOW()
         WHERE id = $1`,
        [id]
      );
    }
    // junk === null: model gave no usable verdict; leave llm_checked_at NULL
    // so the sweep retries this event.

    return inserted.rows;
  });
};

// LLM-classify (and junk-check) all events without a completed combined
// verdict yet. Covers events that were topic-classified before junk screening
// existed — every event needs one call for its verdict anyway, and topics are
// refreshed in the same call at no extra cost.
const classifyUnclassifiedEventsLLM = async () => {
  const result = await db.query(
    `SELECT e.id FROM events e
     WHERE e.llm_checked_at IS NULL
     ORDER BY e.id`
  );
  // classifyEventLLM retries once via gemmaClassifier and falls back to
  // embedding on any failure, so it should not throw; the catch is a safety net.
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
