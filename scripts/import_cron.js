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

const main = async () => {
  const startedAt = new Date().toISOString();
  console.log(`[import-cron] ${startedAt} starting external import sync (full=${FULL})`);
  const headers = await getAuthHeaders();
  const { data } = await requestJson(
    `${API_BASE}/admin/external-imports/sync-all?full=${FULL ? 'true' : 'false'}`,
    { method: 'POST', headers }
  );
  console.log('[import-cron] sync-all result:', JSON.stringify(data));
  console.log(`[import-cron] done at ${new Date().toISOString()}`);
};

main().catch((err) => {
  console.error('[import-cron] failed:', err.message, err.response ? JSON.stringify(err.response.data) : '');
  process.exit(1);
});
