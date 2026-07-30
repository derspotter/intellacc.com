#!/usr/bin/env node

/**
 * External Market Import Scheduler
 *
 * Pulls current questions from all configured external providers
 * (Metaculus, Manifold, Polymarket, Kalshi) via the backend admin proxy,
 * which forwards to the prediction-engine. New events are auto-classified
 * into topics by the backend's import hook.
 *
 * Schedule: daily 03:00 UTC (after the 01:00 daily and 02:00 weekly jobs).
 * Incremental by default (full=false); set IMPORT_FULL=1 for a full sweep.
 */

const requestJson = async (url, { method = 'GET', headers = {}, body = null } = {}) => {
  const init = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== null && body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const error = new Error(`Request failed (${response.status})`);
    error.response = { status: response.status, data };
    throw error;
  }
  return { status: response.status, data };
};

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api';
const ADMIN_TOKEN = process.env.WEEKLY_ADMIN_TOKEN;
const ADMIN_EMAIL = process.env.WEEKLY_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.WEEKLY_ADMIN_PASSWORD;
const FULL = process.env.IMPORT_FULL === '1' || process.env.IMPORT_FULL === 'true';

const getAuthHeaders = async () => {
  if (ADMIN_TOKEN) {
    return { Authorization: `Bearer ${ADMIN_TOKEN}` };
  }
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const loginResponse = await requestJson(`${API_BASE}/login`, {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    if (loginResponse.data?.token) {
      return { Authorization: `Bearer ${loginResponse.data.token}` };
    }
  }
  throw new Error('Import cron requires admin auth: set WEEKLY_ADMIN_TOKEN or WEEKLY_ADMIN_EMAIL/WEEKLY_ADMIN_PASSWORD');
};

// Fire-and-poll: the sync-all request returns immediately (background=true)
// and the engine runs detached, so this script never trips the backend
// proxy's client timeout (which a synchronous full sweep always did).
// Completion = one finished external_import_runs row per announced provider,
// started after the trigger.
const POLL_INTERVAL_MS = 30_000;
const POLL_DEADLINE_MS = 60 * 60_000;

const waitForRuns = async (headers, providers, triggeredAt) => {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  const pending = new Set(providers);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const { data } = await requestJson(
      `${API_BASE}/admin/external-imports/status?limit=25`,
      { headers }
    );
    const runs = Array.isArray(data?.runs) ? data.runs : Array.isArray(data) ? data : [];
    for (const run of runs) {
      if (
        pending.has(run.provider) &&
        run.finished_at &&
        new Date(run.started_at).getTime() >= triggeredAt
      ) {
        pending.delete(run.provider);
        console.log(
          `[import-cron] ${run.provider}: success=${run.success} fetched=${run.fetched_count}` +
            ` created=${run.created_count} linked=${run.linked_count} errors=${run.error_count}` +
            (run.error_count > 0 ? ` ${JSON.stringify(run.errors)}` : '')
        );
      }
    }
    if (pending.size === 0) return true;
  }
  console.error(`[import-cron] timed out waiting for: ${[...pending].join(', ')} (sync continues server-side)`);
  return false;
};

const main = async () => {
  const startedAt = new Date().toISOString();
  console.log(`[import-cron] ${startedAt} starting external import sync (full=${FULL})`);
  const headers = await getAuthHeaders();
  const triggeredAt = Date.now() - 60_000; // clock-skew slack vs. engine timestamps
  const { data } = await requestJson(
    `${API_BASE}/admin/external-imports/sync-all?full=${FULL ? 'true' : 'false'}&background=true`,
    { method: 'POST', headers }
  );
  console.log('[import-cron] sync-all started:', JSON.stringify(data));
  const providers = Array.isArray(data?.providers) && data.providers.length > 0
    ? data.providers
    : ['metaculus', 'manifold', 'polymarket'];
  await waitForRuns(headers, providers, triggeredAt);

  // Engine-imported events bypass the backend's event-creation classification
  // hook, so trigger a topic-classification sweep for the newly imported events.
  try {
    const classify = await requestJson(
      `${API_BASE}/admin/topics/classify-unclassified`,
      { method: 'POST', headers }
    );
    console.log('[import-cron] classification trigger:', JSON.stringify(classify.data));
  } catch (err) {
    // 409 = a sweep is already running; anything else is logged but non-fatal.
    console.error('[import-cron] classification trigger failed:', err.response?.status || err.message);
  }
  console.log(`[import-cron] done at ${new Date().toISOString()}`);
};

main().catch((err) => {
  console.error('[import-cron] failed:', err.message, err.response ? JSON.stringify(err.response.data) : '');
  process.exit(1);
});
