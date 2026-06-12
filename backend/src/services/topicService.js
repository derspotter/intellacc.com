const db = require('../db');
const { embedText } = require('./openRouterMatcher/embeddingService');

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

module.exports = { embedMissingTopicEmbeddings, classifyEvent, classifyUnclassifiedEvents, SECOND_TOPIC_MARGIN };
