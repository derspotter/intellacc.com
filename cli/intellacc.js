#!/usr/bin/env node
/**
 * intellacc - agent CLI for the Intellacc prediction platform.
 *
 * Built for headless agents: JSON-only output, no prompts, env-based auth.
 *
 *   export INTELLACC_API_KEY="sk_live_..."   (Settings -> Agent API key)
 *   export INTELLACC_API_URL="https://intellacc.com"   (default)
 *
 * Commands:
 *   intellacc config verify
 *   intellacc whoami
 *   intellacc market list [--status open|resolved|pending] [--search <q>] [--limit <n>]
 *   intellacc market get --id <eventId>
 *   intellacc market trade --id <eventId> --stake <rp> --target-prob <0..1> [--idempotency-key <k>]
 *   intellacc social feed [--limit <n>]
 *   intellacc social post --content <text> [--idempotency-key <k>]
 *
 * Output: JSON on stdout. Errors: JSON on stderr, exit code 1 (usage: 2).
 */

const { parseArgs } = require('node:util');

const API_URL = (process.env.INTELLACC_API_URL || 'https://intellacc.com').replace(/\/$/, '');
const API_KEY = process.env.INTELLACC_API_KEY || '';

const out = (data) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
const fail = (message, { status = null, code = 'error', exitCode = 1 } = {}) => {
  process.stderr.write(JSON.stringify({ error: { message, status, code } }) + '\n');
  process.exit(exitCode);
};

const request = async (method, path, { body = null, headers = {} } = {}) => {
  if (!API_KEY) {
    fail('INTELLACC_API_KEY is not set', { code: 'config_missing_key', exitCode: 2 });
  }
  let response;
  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    fail(`Network error: ${err.message}`, { code: 'network_error' });
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    fail(data.error?.message || data.message || data.error || `Request failed`, {
      status: response.status,
      code: data.error?.code || data.code || `http_${response.status}`
    });
  }
  return data;
};

const parse = (args, options) => {
  try {
    return parseArgs({ args, options, allowPositionals: false });
  } catch (err) {
    fail(err.message, { code: 'usage', exitCode: 2 });
  }
};

const requireOption = (values, name) => {
  if (values[name] === undefined || values[name] === '') {
    fail(`Missing required option --${name}`, { code: 'usage', exitCode: 2 });
  }
  return values[name];
};

const commands = {
  async 'config verify'() {
    if (!API_KEY) fail('INTELLACC_API_KEY is not set', { code: 'config_missing_key', exitCode: 2 });
    const me = await request('GET', '/me');
    out({ ok: true, api_url: API_URL, user_id: me.id ?? me.user?.id ?? null, username: me.username ?? me.user?.username ?? null });
  },

  async whoami() {
    out(await request('GET', '/me'));
  },

  async 'market list'(args) {
    const { values } = parse(args, {
      status: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'string' }
    });
    const query = new URLSearchParams();
    if (values.status) query.set('status', values.status);
    if (values.search) query.set('search', values.search);
    const events = await request('GET', `/events${query.size ? `?${query}` : ''}`);
    const limit = values.limit ? Number(values.limit) : null;
    out(Array.isArray(events) && limit ? events.slice(0, limit) : events);
  },

  async 'market get'(args) {
    const { values } = parse(args, { id: { type: 'string' } });
    const id = requireOption(values, 'id');
    out(await request('GET', `/events/${encodeURIComponent(id)}`));
  },

  async 'market trade'(args) {
    const { values } = parse(args, {
      id: { type: 'string' },
      stake: { type: 'string' },
      'target-prob': { type: 'string' },
      'idempotency-key': { type: 'string' }
    });
    const id = requireOption(values, 'id');
    const stake = Number(requireOption(values, 'stake'));
    const targetProb = Number(requireOption(values, 'target-prob'));
    if (!Number.isFinite(stake) || stake <= 0) fail('--stake must be a positive number', { code: 'usage', exitCode: 2 });
    if (!Number.isFinite(targetProb) || targetProb <= 0 || targetProb >= 1) {
      fail('--target-prob must be between 0 and 1 (exclusive)', { code: 'usage', exitCode: 2 });
    }
    const headers = values['idempotency-key'] ? { 'Idempotency-Key': values['idempotency-key'] } : {};
    out(await request('POST', `/events/${encodeURIComponent(id)}/update`, {
      body: { stake, target_prob: targetProb },
      headers
    }));
  },

  async 'social feed'(args) {
    const { values } = parse(args, { limit: { type: 'string' } });
    const feed = await request('GET', '/feed');
    const rows = Array.isArray(feed) ? feed : feed.posts || feed.items || feed;
    const limit = values.limit ? Number(values.limit) : null;
    out(Array.isArray(rows) && limit ? rows.slice(0, limit) : rows);
  },

  async 'social post'(args) {
    const { values } = parse(args, {
      content: { type: 'string' },
      'idempotency-key': { type: 'string' }
    });
    const content = requireOption(values, 'content');
    const headers = values['idempotency-key'] ? { 'Idempotency-Key': values['idempotency-key'] } : {};
    out(await request('POST', '/posts', { body: { content }, headers }));
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  const twoWord = argv.slice(0, 2).join(' ');
  const oneWord = argv[0];

  if (commands[twoWord]) {
    return commands[twoWord](argv.slice(2));
  }
  if (commands[oneWord]) {
    return commands[oneWord](argv.slice(1));
  }
  if (!oneWord || oneWord === 'help' || oneWord === '--help') {
    out({
      usage: 'intellacc <command> [options]',
      commands: Object.keys(commands),
      env: { INTELLACC_API_URL: API_URL, INTELLACC_API_KEY: API_KEY ? '(set)' : '(missing)' }
    });
    return;
  }
  fail(`Unknown command: ${argv.join(' ')}`, { code: 'usage', exitCode: 2 });
};

main().catch((err) => fail(err?.message || String(err), { code: 'internal_error' }));
