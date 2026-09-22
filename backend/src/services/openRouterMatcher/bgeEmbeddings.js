const http = require('http');
const db = require('../../db');
const config = require('./config');

const MODEL = 'BAAI/bge-m3';
const DIMENSIONS = 1024;
const LIVE = 'outcome IS NULL AND closing_date > NOW() AND hidden_at IS NULL';
const SOURCE_HASH = "md5(COALESCE(title, '') || chr(31) || COALESCE(details, ''))";
const enabled = () => config.marketEmbedding?.provider === 'bge-m3';
let verifiedUntil = 0;

// SSH authenticates Debian. The socket is private to this host and mounted into
// the backend; no embedding TCP port or provider credentials are exposed.
const request = (path, payload) => new Promise((resolve, reject) => {
  const body = payload === undefined ? null : JSON.stringify(payload);
  if (body && Buffer.byteLength(body) > 64000) return reject(new Error('BGE_INPUT_TOO_LARGE'));
  const req = http.request({
    socketPath: config.marketEmbedding.socketPath,
    path, method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
  }, (response) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > 131072) req.destroy(new Error('BGE_RESPONSE_TOO_LARGE'));
      else chunks.push(chunk);
    });
    response.on('error', () => reject(new Error('BGE_UNAVAILABLE')));
    response.on('end', () => {
      if (response.statusCode !== 200) return reject(new Error('BGE_HTTP_ERROR'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('BGE_INVALID_RESPONSE')); }
    });
  });
  const timer = setTimeout(() => req.destroy(new Error('BGE_TIMEOUT')), config.marketEmbedding.timeoutMs);
  req.on('error', () => reject(new Error('BGE_UNAVAILABLE')));
  req.on('close', () => clearTimeout(timer));
  req.end(body);
});

const embedBgeText = async (text, { usageRecorder } = {}) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error('BGE_EMPTY_INPUT');
  const start = Date.now();
  try {
    if (Date.now() >= verifiedUntil) {
      const info = await request('/info');
      if (info.model_id !== MODEL || info.model_type?.embedding?.pooling !== 'cls') {
        throw new Error('BGE_MODEL_MISMATCH');
      }
      verifiedUntil = Date.now() + 60000;
    }
    const result = await request('/embed', { inputs: normalized, truncate: false });
    const vector = result?.[0];
    if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(vector)
        || vector.length !== DIMENSIONS || !vector.every((v) => typeof v === 'number' && Number.isFinite(v))
        || !vector.some((v) => v !== 0)) throw new Error('BGE_INVALID_VECTOR');
    if (typeof usageRecorder === 'function') {
      try {
        await usageRecorder({ stage: 'retrieval', operation: 'embedding', success: true,
          requestedModel: MODEL, usedModel: MODEL, latencyMs: Date.now() - start,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, costCredits: 0 });
      } catch { /* Accounting must not discard a valid embedding. */ }
    }
    return vector;
  } catch (error) {
    verifiedUntil = 0;
    throw error;
  }
};

const setLiveMarketEmbedding = async (eventId) => {
  if (!enabled()) return false;
  if (!Number.isSafeInteger(Number(eventId)) || Number(eventId) <= 0) throw new Error('Invalid event id');
  const result = await db.query(`SELECT id, title, details, ${SOURCE_HASH} AS source_hash
    FROM events WHERE id = $1 AND ${LIVE}
    AND (embedding_bge_m3 IS NULL OR embedding_bge_m3_source_hash IS DISTINCT FROM ${SOURCE_HASH})`, [eventId]);
  const row = result.rows[0];
  if (!row) return false;
  const vector = await embedBgeText([row.title, row.details].filter(Boolean).join(' '));
  // The market may close, be hidden, or be edited during inference. Never write
  // vectors for a stale snapshot or an ineligible market.
  const updated = await db.query(`UPDATE events SET embedding_bge_m3 = $1::vector,
      embedding_bge_m3_source_hash = $2
    WHERE id = $3 AND ${LIVE} AND ${SOURCE_HASH} = $2`,
  [`[${vector.join(',')}]`, row.source_hash, row.id]);
  return updated.rowCount === 1;
};

const backfillLiveMarketEmbeddings = async () => {
  if (!enabled()) return { selected: 0, updated: 0, failed: 0 };
  const result = await db.query(`SELECT id FROM events WHERE ${LIVE}
    AND (embedding_bge_m3 IS NULL OR embedding_bge_m3_source_hash IS DISTINCT FROM ${SOURCE_HASH}) ORDER BY id`);
  const counts = { selected: result.rows.length, updated: 0, failed: 0 };
  for (const row of result.rows) {
    try { if (await setLiveMarketEmbedding(row.id)) counts.updated += 1; }
    catch { counts.failed += 1; console.warn('[BGE] Live market embedding failed:', row.id); }
  }
  return counts;
};

module.exports = { enabled, embedBgeText, setLiveMarketEmbedding, backfillLiveMarketEmbeddings };
