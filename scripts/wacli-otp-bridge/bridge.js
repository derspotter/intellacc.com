#!/usr/bin/env node
/**
 * wacli OTP bridge — host-side send gateway for Intellacc WhatsApp OTP.
 *
 * Runs on the HOST (systemd, as the user owning the wacli store), never in a
 * container. The internet-facing backend can only POST an OTP-template text
 * to a phone number; it can never read the wacli store or send arbitrary
 * content. Containment properties, enforced HERE (not trusted to the caller):
 *   - bearer-token auth on every route
 *   - message must match the exact OTP template
 *   - recipient must be 8-15 digits; sent as an explicit user JID so wacli
 *     can never fall back to contact-name matching
 *   - rate caps: per-number/hour, global/day, minimum gap between sends
 *   - sends serialized (single wacli store; --lock-wait handles CLI overlap)
 *
 * Config (env, see wacli-otp-bridge.env.example):
 *   BRIDGE_TOKEN     required, min 32 chars
 *   BRIDGE_SOCKET    unix socket path (preferred: bind-mounted into the
 *                    backend container; no TCP, no firewall interaction)
 *   BRIDGE_PORT      default 8790 (TCP listeners, only when BRIDGE_BIND set)
 *   BRIDGE_BIND      comma-separated addresses (default 127.0.0.1 when no socket)
 *   WACLI_BIN        default ~/.local/bin/wacli
 *   SEND_TIMEOUT_MS  default 30000
 *   MAX_PER_NUMBER_PER_HOUR  default 3
 *   MAX_GLOBAL_PER_DAY       default 100
 *   MIN_SEND_GAP_MS          default 2000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TOKEN = process.env.BRIDGE_TOKEN || '';
const SOCKET = String(process.env.BRIDGE_SOCKET || '').trim();
const PORT = parseInt(process.env.BRIDGE_PORT || '8790', 10);
const BINDS = String(process.env.BRIDGE_BIND || (SOCKET ? '' : '127.0.0.1')).split(',').map((s) => s.trim()).filter(Boolean);
const WACLI_BIN = process.env.WACLI_BIN || path.join(os.homedir(), '.local', 'bin', 'wacli');
const SEND_TIMEOUT_MS = parseInt(process.env.SEND_TIMEOUT_MS || '30000', 10);
const MAX_PER_NUMBER_PER_HOUR = parseInt(process.env.MAX_PER_NUMBER_PER_HOUR || '3', 10);
const MAX_GLOBAL_PER_DAY = parseInt(process.env.MAX_GLOBAL_PER_DAY || '100', 10);
const MIN_SEND_GAP_MS = parseInt(process.env.MIN_SEND_GAP_MS || '2000', 10);

const OTP_TEMPLATE = /^Intellacc verification code: \d{6}$/;
const RECIPIENT = /^\d{8,15}$/;
const HEALTH_CACHE_MS = 5 * 60 * 1000;

if (!TOKEN || TOKEN.length < 32) {
  console.error('[bridge] BRIDGE_TOKEN missing or shorter than 32 chars — refusing to start');
  process.exit(1);
}

const last4 = (digits) => `…${String(digits).slice(-4)}`;

// --- rate limiting (in-memory; resets on restart — defense in depth only,
// the backend's challenge machinery is the primary limiter) ---
const perNumberSends = new Map(); // digits -> [timestamps]
let globalSends = []; // timestamps
let lastSendAt = 0;

const pruneAndCount = (arr, windowMs) => {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr.length;
};

const checkRateLimits = (digits) => {
  if (pruneAndCount(globalSends, 24 * 3600 * 1000) >= MAX_GLOBAL_PER_DAY) {
    return 'global daily send cap reached';
  }
  const list = perNumberSends.get(digits) || [];
  if (pruneAndCount(list, 3600 * 1000) >= MAX_PER_NUMBER_PER_HOUR) {
    return 'per-number hourly send cap reached';
  }
  return null;
};

const recordSend = (digits) => {
  const now = Date.now();
  globalSends.push(now);
  const list = perNumberSends.get(digits) || [];
  list.push(now);
  perNumberSends.set(digits, list);
  if (perNumberSends.size > 5000) perNumberSends.clear(); // unbounded-map guard
};

// --- wacli invocation, serialized ---
let sendChain = Promise.resolve();

const runWacli = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(WACLI_BIN, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      // --json puts the real error in stdout as {"success":false,"error":...}
      let jsonError = '';
      try { jsonError = String(JSON.parse(String(stdout)).error || ''); } catch (e) { /* not JSON */ }
      const summary = (
        jsonError ||
        String(stderr || '').trim().split('\n').pop() ||
        String(err.message || '')
      ).slice(0, 300);
      reject(new Error(summary || `wacli exited with ${err.code}`));
    } else {
      resolve(String(stdout || ''));
    }
  });
});

const sendOtp = (digits, message) => {
  const task = sendChain.then(async () => {
    const gap = Date.now() - lastSendAt;
    if (gap < MIN_SEND_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_SEND_GAP_MS - gap));
    }
    lastSendAt = Date.now();
    // explicit user JID — wacli must never resolve this as a contact name.
    // No --lock-wait: the wacli-sync daemon holds the store lock permanently
    // and `send` delegates to it (wacli.sh/send). Passing --lock-wait forces
    // direct store access, which then blocks forever on the daemon's lock.
    await runWacli([
      'send', 'text',
      '--to', `${digits}@s.whatsapp.net`,
      '--message', message,
      '--json'
    ], SEND_TIMEOUT_MS);
  });
  sendChain = task.catch(() => {});
  return task;
};

// --- health (wacli doctor, cached) ---
let healthCache = { ok: false, checkedAt: 0, detail: 'not checked yet' };

const checkHealth = async () => {
  if (Date.now() - healthCache.checkedAt < HEALTH_CACHE_MS) return healthCache;
  try {
    await runWacli(['doctor', '--json'], 15000);
    healthCache = { ok: true, checkedAt: Date.now(), detail: null };
  } catch (err) {
    healthCache = { ok: false, checkedAt: Date.now(), detail: String(err.message).slice(0, 200) };
  }
  return healthCache;
};

// --- http ---
const respond = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 4096) {
      reject(new Error('body too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const timingSafeTokenMatch = (provided) => {
  const crypto = require('crypto');
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const handler = async (req, res) => {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!timingSafeTokenMatch(token)) {
    return respond(res, 401, { ok: false, error: 'unauthorized' });
  }

  if (req.method === 'GET' && req.url === '/health') {
    const health = await checkHealth();
    return respond(res, health.ok ? 200 : 503, { ok: health.ok, detail: health.detail });
  }

  if (req.method === 'POST' && req.url === '/send') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return respond(res, 400, { ok: false, error: 'invalid JSON body' });
    }

    const digits = String(body.to || '');
    const message = String(body.message || '');
    if (!RECIPIENT.test(digits)) {
      return respond(res, 400, { ok: false, error: 'recipient must be 8-15 digits (E.164 without +)' });
    }
    if (!OTP_TEMPLATE.test(message)) {
      return respond(res, 400, { ok: false, error: 'message does not match the OTP template' });
    }
    const limited = checkRateLimits(digits);
    if (limited) {
      console.warn(`[bridge] rate-limited send to ${last4(digits)}: ${limited}`);
      return respond(res, 429, { ok: false, error: limited });
    }

    try {
      await sendOtp(digits, message);
      recordSend(digits);
      console.log(`[bridge] sent OTP to ${last4(digits)}`);
      return respond(res, 200, { ok: true });
    } catch (err) {
      console.error(`[bridge] send to ${last4(digits)} failed: ${err.message}`);
      return respond(res, 502, { ok: false, error: 'send failed' });
    }
  }

  return respond(res, 404, { ok: false, error: 'not found' });
};

const makeServer = () => http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error('[bridge] handler error:', err.message);
    respond(res, 500, { ok: false, error: 'internal error' });
  });
});

if (SOCKET) {
  try { fs.unlinkSync(SOCKET); } catch (e) { /* stale socket only */ }
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  makeServer().listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o660);
    console.log(`[bridge] listening on unix:${SOCKET} (wacli: ${WACLI_BIN})`);
  });
}

for (const bind of BINDS) {
  makeServer().listen(PORT, bind, () => {
    console.log(`[bridge] listening on ${bind}:${PORT} (wacli: ${WACLI_BIN})`);
  });
}

if (!SOCKET && BINDS.length === 0) {
  console.error('[bridge] no BRIDGE_SOCKET and no BRIDGE_BIND — nothing to listen on');
  process.exit(1);
}
