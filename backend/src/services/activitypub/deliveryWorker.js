const crypto = require('crypto');
const db = require('../../db');
const { ACTIVITY_JSON } = require('./constants');
const { computeDigestHeader } = require('./signatureService');
const { ensureServerKey } = require('./keyService');
const { assertSsrfSafeUrl } = require('./ssrf');

const DEFAULT_INTERVAL_MS = 10 * 1000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_ATTEMPTS = 10;

const getAllowPrivateNetworks = () => {
  if (process.env.FEDERATION_ALLOW_PRIVATE_NETWORKS === 'true') return true;
  return process.env.NODE_ENV === 'test';
};

const getAllowHosts = () => {
  const raw = String(process.env.FEDERATION_ALLOWLIST_HOSTS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((h) => h.trim()).filter(Boolean);
};

const computeNextAttemptAt = (attemptCount) => {
  const baseSeconds = 60;
  const exp = Math.min(attemptCount - 1, 8);
  const seconds = Math.min(baseSeconds * (2 ** exp), 6 * 60 * 60);
  const jitter = Math.floor(Math.random() * 15);
  return new Date(Date.now() + (seconds + jitter) * 1000);
};

const buildSignatureHeader = ({ signingKeyId, privateKeyPem, method, url, date, digest, contentType }) => {
  const headersList = '(request-target) host date digest content-type';
  const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search || ''}`;
  const signingString = [
    `(request-target): ${requestTarget}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: ${contentType}`
  ].join('\n');

  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingString, 'utf8'), privateKeyPem).toString('base64');
  return `keyId=\"${signingKeyId}\",algorithm=\"rsa-sha256\",headers=\"${headersList}\",signature=\"${signature}\"`;
};

const deliverOnce = async ({ targetUrl, signingKeyId, payload }) => {
  const allowPrivate = getAllowPrivateNetworks();
  const allowHosts = getAllowHosts();
  const safeUrl = await assertSsrfSafeUrl(targetUrl, { allowPrivate, allowHosts });

  const { privateKeyPem } = await ensureServerKey();

  const bodyText = JSON.stringify(payload);
  const bodyBuf = Buffer.from(bodyText, 'utf8');
  const date = new Date().toUTCString();
  const digest = computeDigestHeader(bodyBuf);
  const contentType = ACTIVITY_JSON;
  const signature = buildSignatureHeader({
    signingKeyId,
    privateKeyPem,
    method: 'POST',
    url: safeUrl,
    date,
    digest,
    contentType
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(safeUrl.toString(), {
      method: 'POST',
      headers: {
        host: safeUrl.host,
        date,
        digest,
        'content-type': contentType,
        signature,
        'user-agent': 'Intellacc-Federation/0.1'
      },
      body: bodyText,
      signal: controller.signal
    });

    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
};

const processDueDeliveries = async (limit = DEFAULT_BATCH_SIZE) => {
  const pool = db.getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `WITH claimed AS (
         SELECT id
         FROM federation_delivery_queue
         WHERE protocol = 'ap'
           AND status = 'pending'
           AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE federation_delivery_queue q
       SET attempt_count = attempt_count + 1,
           last_attempt_at = NOW(),
           updated_at = NOW()
       FROM claimed
       WHERE q.id = claimed.id
       RETURNING q.id, q.target_url, q.signing_key_id, q.payload, q.attempt_count`,
      [limit]
    );
    await client.query('COMMIT');

    let processed = 0;
    for (const row of claimed.rows) {
      processed += 1;
      const attemptCount = row.attempt_count;

      try {
        const result = await deliverOnce({
          targetUrl: row.target_url,
          signingKeyId: row.signing_key_id,
          payload: row.payload
        });

        if (result.ok) {
          await db.query(
            `UPDATE federation_delivery_queue
             SET status = 'delivered',
                 delivered_at = NOW(),
                 last_status_code = $2,
                 last_error = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id, result.status]
          );
          continue;
        }

        const next = attemptCount >= MAX_ATTEMPTS ? null : computeNextAttemptAt(attemptCount);
        await db.query(
          `UPDATE federation_delivery_queue
           SET status = $2,
               next_attempt_at = COALESCE($3, next_attempt_at),
               last_status_code = $4,
               last_error = $5,
               updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            attemptCount >= MAX_ATTEMPTS ? 'dead' : 'pending',
            next,
            result.status,
            `HTTP ${result.status}`
          ]
        );
      } catch (err) {
        const next = attemptCount >= MAX_ATTEMPTS ? null : computeNextAttemptAt(attemptCount);
        await db.query(
          `UPDATE federation_delivery_queue
           SET status = $2,
               next_attempt_at = COALESCE($3, next_attempt_at),
               last_status_code = NULL,
               last_error = $4,
               updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            attemptCount >= MAX_ATTEMPTS ? 'dead' : 'pending',
            next,
            err?.message ? String(err.message).slice(0, 500) : 'Delivery failed'
          ]
        );
      }
    }

    return processed;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
};

const startDeliveryWorker = ({ intervalMs = DEFAULT_INTERVAL_MS } = {}) => {
  const timer = setInterval(async () => {
    try {
      await processDueDeliveries();
    } catch (err) {
      console.error('[FederationDelivery] Worker error:', err?.message || err);
    }
  }, intervalMs);
  timer.unref();
};

module.exports = {
  processDueDeliveries,
  startDeliveryWorker
};

