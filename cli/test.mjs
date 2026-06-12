// Integration test for the agent CLI against a mock API server.
// Run: node cli/test.mjs (no dependencies; exits non-zero on failure).

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'intellacc.js');
const seen = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'], body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/me') {
      res.end(JSON.stringify({ id: 7, username: 'agentuser' }));
    } else if (req.url.startsWith('/api/events/42/update')) {
      res.end(JSON.stringify({ event_id: 42, new_prob: 0.61 }));
    } else if (req.url.startsWith('/api/events?')) {
      res.end(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
    } else if (req.url === '/api/posts' && req.method === 'POST') {
      res.end(JSON.stringify({ id: 99, content: JSON.parse(body).content }));
    } else if (req.url === '/api/forbidden') {
      res.statusCode = 403;
      res.end(JSON.stringify({ message: 'API Key missing required scope: market:trade' }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
    }
  });
});

const run = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [cliPath, ...args], {
    env: { ...process.env, INTELLACC_API_URL: base, INTELLACC_API_KEY: 'sk_live_test', ...env }
  }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr }));
});

let base;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;

try {
  // whoami maps to /api/me with bearer auth
  let r = await run(['whoami']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).username, 'agentuser');
  assert.equal(seen.at(-1).auth, 'Bearer sk_live_test');

  // market list passes filters and applies client-side limit
  r = await run(['market', 'list', '--status', 'open', '--limit', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 2);
  assert.ok(seen.at(-1).url.includes('status=open'));

  // trade sends stake/target_prob and the Idempotency-Key header
  r = await run(['market', 'trade', '--id', '42', '--stake', '10', '--target-prob', '0.61', '--idempotency-key', 'abc']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(seen.at(-1).body).stake, 10);
  assert.equal(JSON.parse(seen.at(-1).body).target_prob, 0.61);
  assert.equal(seen.at(-1).idem, 'abc');

  // social post sends content
  r = await run(['social', 'post', '--content', 'agent says hi']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).content, 'agent says hi');

  // usage errors exit 2 with JSON on stderr
  r = await run(['market', 'trade', '--id', '42']);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'usage');

  // missing key exits 2
  r = await run(['whoami'], { INTELLACC_API_KEY: '' });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'config_missing_key');

  // invalid prob rejected client-side
  r = await run(['market', 'trade', '--id', '42', '--stake', '10', '--target-prob', '1.5']);
  assert.equal(r.code, 2);

  console.log('cli tests: all passed');
} finally {
  server.close();
}
