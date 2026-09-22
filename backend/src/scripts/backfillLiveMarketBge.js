// Uses the provider and private socket configured for the backend. No legacy
// embeddings are changed, and eligibility is rechecked before every write.
const db = require('../db');
const bge = require('../services/openRouterMatcher/bgeEmbeddings');
(async () => {
  if (!bge.enabled()) throw new Error('Enable POST_SIGNAL_MARKET_EMBEDDING_PROVIDER=bge-m3 for this command');
  const counts = await bge.backfillLiveMarketEmbeddings();
  console.log(JSON.stringify(counts));
  if (counts.failed) process.exitCode = 1;
})().catch(() => { console.error('Live market BGE backfill failed'); process.exitCode = 1; })
  .finally(() => db.closePool());
