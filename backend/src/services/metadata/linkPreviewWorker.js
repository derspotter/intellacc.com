const { randomUUID } = require('crypto');
const db = require('../../db');
const { extractFirstUrl, fetchMetadata } = require('./metadataService');

const previewUrl = (content) => {
  const raw = extractFirstUrl(content);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
};

// Called in the post edit transaction. A new generation fences out any job
// still fetching the previous URL, including an edit from A -> B -> A.
const enqueuePreview = async (client, postId, url) => {
  if (!url) {
    await client.query('DELETE FROM post_link_preview_jobs WHERE post_id = $1', [postId]);
    return;
  }
  await client.query(`INSERT INTO post_link_preview_jobs (post_id, url) VALUES ($1, $2)
    ON CONFLICT (post_id) DO UPDATE SET url = EXCLUDED.url,
      generation = EXCLUDED.generation, attempts = 0, available_at = NOW(),
      lease_id = NULL, locked_until = NULL, last_error = NULL`, [postId, url]);
};

const createPreviewWorker = ({ io, concurrency = 2, intervalMs = 2000 } = {}) => {
  const limit = Math.max(1, Math.min(8, Math.trunc(concurrency) || 2));
  const downloads = new Map();
  let running = null;
  let timer;

  const loadMetadata = (url) => {
    if (downloads.has(url)) return downloads.get(url);
    const loading = (async () => {
      const cached = await db.query(`SELECT title, description, image_url, site_name
        FROM link_metadata WHERE url = $1 AND updated_at > NOW() - INTERVAL '24 hours'
        AND (title IS NOT NULL OR description IS NOT NULL OR image_url IS NOT NULL)`, [url]);
      if (cached.rows[0]) return { ...cached.rows[0], cached: true };
      const metadata = await fetchMetadata(url, { throwOnError: true });
      if (!metadata || !(metadata.title || metadata.description || metadata.image_url)) {
        throw new Error('No usable preview metadata');
      }
      return metadata;
    })();
    downloads.set(url, loading);
    loading.finally(() => downloads.delete(url)).catch(() => {});
    return loading;
  };

  const persist = async (job, metadata) => {
    const client = await db.getPool().connect();
    let authorId;
    try {
      await client.query('BEGIN');
      // Post-first order matches edit transactions and prevents lock inversion.
      const post = (await client.query('SELECT user_id, link_url, is_hidden FROM posts WHERE id = $1 FOR UPDATE', [job.post_id])).rows[0];
      const current = await client.query(`SELECT post_id FROM post_link_preview_jobs
        WHERE post_id = $1 AND generation = $2 AND lease_id = $3 FOR UPDATE`,
      [job.post_id, job.generation, job.lease_id]);
      if (post && !post.is_hidden && post.link_url === job.url && current.rows.length) {
        // Cache by normalized requested URL (redirect aliases remain reusable).
        // Reusing a cache entry must not extend its original freshness window.
        const result = await client.query(`INSERT INTO link_metadata (url, title, description, image_url, site_name, content)
          VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT (url) DO UPDATE SET
          title = CASE WHEN $6 THEN link_metadata.title ELSE EXCLUDED.title END,
          description = CASE WHEN $6 THEN link_metadata.description ELSE EXCLUDED.description END,
          image_url = CASE WHEN $6 THEN link_metadata.image_url ELSE EXCLUDED.image_url END,
          site_name = CASE WHEN $6 THEN link_metadata.site_name ELSE EXCLUDED.site_name END,
          content = NULL, updated_at = CASE WHEN $6 THEN link_metadata.updated_at ELSE NOW() END
          RETURNING id`, [job.url, metadata.title, metadata.description, metadata.image_url, metadata.site_name, !!metadata.cached]);
        await client.query('UPDATE posts SET link_metadata_id = $2 WHERE id = $1', [job.post_id, result.rows[0].id]);
        authorId = post.user_id;
      }
      await client.query(`DELETE FROM post_link_preview_jobs
        WHERE post_id = $1 AND generation = $2 AND lease_id = $3`, [job.post_id, job.generation, job.lease_id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    // Notify the author without broadcasting post content to other viewers.
    if (authorId) io?.to(`user:${authorId}`).emit('post_preview_updated', { post_id: job.post_id });
  };

  const processJob = async (job) => {
    try {
      await persist(job, await loadMetadata(job.url));
    } catch (error) {
      // A lease/generation check prevents an old failure from rescheduling edits.
      await db.query(`UPDATE post_link_preview_jobs SET lease_id = NULL, locked_until = NULL,
        available_at = NOW() + ($4 * INTERVAL '1 second'), last_error = $5
        WHERE post_id = $1 AND generation = $2 AND lease_id = $3`,
      [job.post_id, job.generation, job.lease_id, 30 * (2 ** (job.attempts - 1)), String(error.message || error).slice(0, 300)]);
    }
  };

  const runOnce = () => {
    if (running) return running;
    running = (async () => {
      // This statement commits its claim before any remote I/O. Expiring leases
      // recover interrupted workers, and SKIP LOCKED allows multiple processes.
      const jobs = await db.query(`WITH ready AS (
        SELECT j.post_id FROM post_link_preview_jobs j JOIN posts p ON p.id = j.post_id
        WHERE j.attempts < 3 AND j.available_at <= NOW() AND p.is_hidden = FALSE
          AND (j.locked_until IS NULL OR j.locked_until < NOW())
        ORDER BY j.available_at, j.post_id FOR UPDATE OF j SKIP LOCKED LIMIT $1
      ) UPDATE post_link_preview_jobs j SET attempts = j.attempts + 1,
        lease_id = $2, locked_until = NOW() + INTERVAL '60 seconds'
        FROM ready WHERE j.post_id = ready.post_id RETURNING j.*`, [limit, randomUUID()]);
      // Keep the overlap guard until every slot finishes, even if a database
      // failure prevents one job from recording its retry state.
      const results = await Promise.allSettled(jobs.rows.map(processJob));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    })().finally(() => { running = null; });
    return running;
  };
  const start = () => {
    if (timer) return;
    const tick = () => runOnce().catch((error) => console.error('[LinkPreview] Worker failed:', error.message));
    timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
  };
  const stop = () => { clearInterval(timer); timer = null; };
  return { start, stop, runOnce };
};

module.exports = { previewUrl, enqueuePreview, createPreviewWorker };
