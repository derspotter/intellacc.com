const { setEventEmbedding, backfillEmbeddings } = require('./openRouterMatcher/embeddingService');
const topicService = require('./topicService');

const SWEEP_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.EVENT_EMBEDDING_SWEEP_INTERVAL_MS) || 6 * 60 * 60 * 1000
);

let sweepTimer = null;

// Catch-all so every market always ends up embedded, whatever path created it
// (direct create, question approval, engine imports, later unhides): embeds
// all events still missing an embedding. Individual failures are logged and
// retried on the next sweep.
const startEmbeddingSweepWorker = () => {
  if (process.env.NODE_ENV === 'test') return;
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('[Event] Embedding sweep worker disabled (no OPENROUTER_API_KEY)');
    return;
  }
  if (sweepTimer) return;

  const run = async () => {
    try {
      await backfillEmbeddings();
    } catch (error) {
      console.error('[Event] Embedding sweep failed:', error.message);
    }
  };

  console.log(`[Event] Embedding sweep worker started (every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m, first pass in 60s)`);
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  setTimeout(run, 60 * 1000).unref?.();
};

// Fire-and-forget enrichment for a newly created event: embedding (powers the
// matcher + market-attach suggestions), then topic classification.
// Skipped under NODE_ENV=test: it reaches external embedding/LLM services that
// are unavailable in CI, and being un-awaited it logs after the triggering
// test tears down ("Cannot log after tests are done" → Jest exits 1). Tests
// mock this module and assert the call boundary instead.
const enrichEventInBackground = (event) => {
  if (!event?.id) return;
  if (process.env.NODE_ENV === 'test') return;

  (async () => {
    try {
      await setEventEmbedding({
        eventId: event.id,
        title: event.title,
        details: event.details
      });
    } catch (error) {
      console.error('[Event] Background embedding failed for event', event.id, error.message);
    }
    try {
      await topicService.classifyEventLLM(event.id);
    } catch (error) {
      console.error('[Event] Background classification failed for event', event.id, error.message);
    }
  })();
};

module.exports = { enrichEventInBackground, startEmbeddingSweepWorker };
