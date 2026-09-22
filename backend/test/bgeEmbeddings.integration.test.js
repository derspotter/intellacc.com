const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intellacc-bge-test-'));
process.env.POST_SIGNAL_MARKET_EMBEDDING_PROVIDER = 'bge-m3';
process.env.POST_SIGNAL_BGE_SOCKET = path.join(directory, 'tei.sock');
process.env.POST_SIGNAL_BGE_TIMEOUT_MS = '100';
const db = require('../src/db');
const bge = require('../src/services/openRouterMatcher/bgeEmbeddings');
const retrieval = require('../src/services/openRouterMatcher/marketRetrieval');
const config = require('../src/services/openRouterMatcher/config');
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
let mode = 'ok';
let onEmbed;
let calls = 0;
const ids = [];
const server = http.createServer(async (req, res) => {
  req.resume();
  if (req.url === '/info') {
    res.end(JSON.stringify({ model_id: mode === 'wrong-model' ? 'another/model' : 'BAAI/bge-m3', model_type: { embedding: { pooling: 'cls' } } }));
    return;
  }
  calls += 1;
  if (onEmbed) await onEmbed();
  if (mode === 'timeout') return;
  if (mode === 'error') { res.writeHead(503); res.end('{}'); return; }
  res.end(JSON.stringify([mode === 'wrong-dimension' ? [1, 0] : vector]));
});
const createEvent = async (overrides = {}) => {
  const row = { title: 'Quasarwidget rocket launch', details: 'A synthetic market.',
    closing: new Date(Date.now() + 86400000), hidden: null, outcome: null, ...overrides };
  const result = await db.query(`INSERT INTO events (title, details, closing_date, hidden_at, outcome, event_type)
    VALUES ($1,$2,$3,$4,$5,'binary') RETURNING id`, [row.title, row.details, row.closing, row.hidden, row.outcome]);
  ids.push(result.rows[0].id);
  return result.rows[0].id;
};
beforeAll(async () => { await new Promise((resolve) => server.listen(process.env.POST_SIGNAL_BGE_SOCKET, resolve)); });
beforeEach(() => { mode = 'ok'; calls = 0; onEmbed = null; });
afterEach(async () => { if (ids.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [ids.splice(0)]); });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmdirSync(directory);
  await db.closePool();
});

test('rejects a different model and wrong vector dimensions', async () => {
  mode = 'wrong-model';
  await expect(bge.embedBgeText('synthetic text')).rejects.toThrow('BGE_MODEL_MISMATCH');
  expect(calls).toBe(0);
  mode = 'wrong-dimension';
  await expect(bge.embedBgeText('synthetic text')).rejects.toThrow('BGE_INVALID_VECTOR');
});

test('only live visible unresolved markets are embedded and legacy vectors stay intact', async () => {
  const live = await createEvent();
  const closed = await createEvent({ closing: new Date(Date.now() - 1000) });
  const hidden = await createEvent({ hidden: new Date() });
  const resolved = await createEvent({ outcome: true });
  const old = `[${Array.from({ length: 768 }, (_, i) => i === 1 ? 1 : 0).join(',')}]`;
  await db.query('UPDATE events SET embedding=$1::vector WHERE id=$2', [old, live]);
  expect(await bge.setLiveMarketEmbedding(live)).toBe(true);
  for (const id of [closed, hidden, resolved]) expect(await bge.setLiveMarketEmbedding(id)).toBe(false);
  expect(calls).toBe(1);
  expect(await bge.setLiveMarketEmbedding(live)).toBe(false);
  expect(calls).toBe(1);
  const result = await db.query('SELECT embedding::text AS old, vector_dims(embedding_bge_m3) AS dims FROM events WHERE id=$1', [live]);
  expect(result.rows[0]).toEqual({ old, dims: 1024 });
});

test.each(['hide', 'close', 'resolve', 'edit'])('rejects a stale write after concurrent %s', async (change) => {
  const id = await createEvent();
  onEmbed = async () => {
    const clauses = { hide: 'hidden_at=NOW()', close: "closing_date=NOW()-INTERVAL '1 second'", resolve: 'outcome=TRUE', edit: "title='Changed market title'" };
    await db.query(`UPDATE events SET ${clauses[change]} WHERE id=$1`, [id]);
  };
  expect(await bge.setLiveMarketEmbedding(id)).toBe(false);
  const result = await db.query('SELECT embedding_bge_m3 IS NULL AS empty FROM events WHERE id=$1', [id]);
  expect(result.rows[0].empty).toBe(true);
});

test('sweep covers newly unhidden and edited live markets but skips ineligible ones', async () => {
  const live = await createEvent();
  const hidden = await createEvent({ hidden: new Date() });
  const closed = await createEvent({ closing: new Date(Date.now() - 1000) });
  const resolved = await createEvent({ outcome: true });
  await bge.backfillLiveMarketEmbeddings();
  await db.query("UPDATE events SET title='Updated Quasarwidget launch' WHERE id=$1", [live]);
  await db.query('UPDATE events SET hidden_at=NULL WHERE id=$1', [hidden]);
  const counts = await bge.backfillLiveMarketEmbeddings();
  expect(counts).toEqual({ selected: 2, updated: 2, failed: 0 });
  const excluded = await db.query('SELECT count(*)::int AS n FROM events WHERE id=ANY($1::int[]) AND embedding_bge_m3 IS NOT NULL', [[closed, resolved]]);
  expect(excluded.rows[0].n).toBe(0);
});

test('hybrid includes keyword-only matches and excludes stale vectors', async () => {
  const live = await createEvent();
  const stale = await createEvent({ title: 'Unrelatedzyx market' });
  await bge.setLiveMarketEmbedding(stale);
  await db.query("UPDATE events SET details='Edited criteria' WHERE id=$1", [stale]);
  const candidates = await retrieval.retrieveCandidateMarkets('Quasarwidget', [], null);
  expect(candidates.map((c) => c.event_id)).toContain(live);
  expect(candidates.map((c) => c.event_id)).not.toContain(stale);
  expect(candidates.find((c) => c.event_id === live).vec_score).toBe(0);
});

test.each(['error', 'timeout'])('embedding %s falls back to live keyword search without mixing vector spaces', async (failure) => {
  const live = await createEvent();
  const closed = await createEvent({ closing: new Date(Date.now() - 1000) });
  const hidden = await createEvent({ hidden: new Date() });
  const resolved = await createEvent({ outcome: true });
  mode = failure;
  const candidates = await retrieval.retrieveCandidateMarkets('Quasarwidget', [], null);
  expect(candidates.map((c) => c.event_id)).toContain(live);
  for (const id of [closed, hidden, resolved]) expect(candidates.map((c) => c.event_id)).not.toContain(id);
  expect(candidates.every((c) => c.vec_score === 0)).toBe(true);
});

test('OpenRouter mode continues to use only the original vector column', async () => {
  config.marketEmbedding.provider = 'openrouter';
  try { expect(await bge.setLiveMarketEmbedding(await createEvent())).toBe(false); }
  finally { config.marketEmbedding.provider = 'bge-m3'; }
  expect(calls).toBe(0);
});
