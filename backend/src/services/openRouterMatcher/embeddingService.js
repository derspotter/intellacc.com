const db = require('../../db');
const config = require('./config');
const { callEmbedding } = require('./llmClient');

const cleanText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim();

const hasEmbeddingColumn = async () => {
  const result = await db.query(`
    SELECT EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'events'
        AND column_name = 'embedding'
    ) AS has_embedding_column
  `);

  return result.rows[0]?.has_embedding_column === true;
};

const toVectorLiteral = (embedding) => {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding vector is empty');
  }

  return `[${embedding.map(Number).join(',')}]`;
};

const embedText = async (text) => {
  const normalized = cleanText(text);
  if (!normalized) {
    throw new Error('No text to embed');
  }

  return callEmbedding({
    input: normalized,
    model: config.embedding.model,
    timeoutMs: config.embedding.timeoutMs
  });
};

const setEventEmbedding = async ({ eventId, title, details }) => {
  if (!Number.isInteger(Number(eventId))) {
    throw new Error('Invalid event id');
  }

  const hasColumn = await hasEmbeddingColumn();
  if (!hasColumn) {
    return false;
  }

  const normalizedTitle = cleanText(title);
  const normalizedDetails = cleanText(details);
  const text = [normalizedTitle, normalizedDetails].filter(Boolean).join(' ');
  if (!text) {
    return false;
  }

  const embedding = await embedText(text);
  const vectorLiteral = toVectorLiteral(embedding);

  await db.query(
    `UPDATE events
     SET embedding = $1::vector
     WHERE id = $2`,
    [vectorLiteral, eventId]
  );

  return true;
};

const backfillEmbeddings = async () => {
  const result = await db.query(`
    SELECT id, title, details
    FROM events
    WHERE embedding IS NULL
  `);

  for (const row of result.rows) {
    try {
      await setEventEmbedding({
        eventId: row.id,
        title: row.title,
        details: row.details
      });
    } catch (error) {
      console.error('[Matcher] Embedding backfill failed for event', row.id, error.message);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
};

module.exports = {
  embedText,
  setEventEmbedding,
  backfillEmbeddings
};
