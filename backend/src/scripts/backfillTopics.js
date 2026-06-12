// backend/src/scripts/backfillTopics.js
// One-shot, idempotent: embed topics, embed events missing embeddings,
// classify all unclassified events. Run inside the backend container:
//   docker exec intellacc_backend node src/scripts/backfillTopics.js
const db = require('../db');
const { backfillEmbeddings } = require('../services/openRouterMatcher/embeddingService');
const topicService = require('../services/topicService');

const main = async () => {
  console.log('[backfill] embedding user-facing topics…');
  const topicsEmbedded = await topicService.embedMissingTopicEmbeddings();
  console.log(`[backfill] topics embedded: ${topicsEmbedded}`);

  console.log('[backfill] embedding events without embeddings…');
  await backfillEmbeddings(); // existing service; logs failures per event

  console.log('[backfill] classifying events…');
  const classified = await topicService.classifyUnclassifiedEvents();
  console.log(`[backfill] events classified: ${classified}`);

  const stats = await db.query(
    `SELECT t.slug, COUNT(et.event_id) AS events
     FROM topics t LEFT JOIN event_topics et ON et.topic_id = t.id
     WHERE t.is_user_facing GROUP BY t.slug ORDER BY events DESC`
  );
  console.table(stats.rows);
  await db.closePool();
  process.exit(0);
};

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
