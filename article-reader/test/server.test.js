const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

const fixture = async (read, options) => {
  const server = createServer(read, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { post: (body) => fetch(`${endpoint}/read`, { method: 'POST', body: JSON.stringify(body) }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
};

test('rejects malformed bodies without starting a browser', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls += 1; });
  try {
    assert.equal((await f.post({})).status, 422);
    assert.equal((await f.post({ url: 'x'.repeat(9000) })).status, 422);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('bounds concurrent reads without queueing and returns capacity after completion', async () => {
  const pending = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(() => new Promise(resolve => { pending.push(resolve); if (pending.length === 2) started(); }));
  try {
    const first = f.post({ url: 'https://example.org/1' });
    const second = f.post({ url: 'https://example.org/2' });
    await ready;
    assert.equal((await f.post({ url: 'https://example.org/3' })).status, 503);
    pending.forEach(resolve => resolve({ text: 'Article' }));
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  } finally { await f.close(); }
});

test('timeout cancels browser work and restores capacity', async () => {
  let cancelled = 0;
  const f = await fixture((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled += 1; reject(new Error('cancelled')); }, { once: true });
  }), { timeoutMs: 25 });
  try {
    assert.equal((await f.post({ url: 'https://example.org/slow' })).status, 504);
    assert.equal((await f.post({ url: 'https://example.org/slow' })).status, 504);
    assert.equal(cancelled, 2);
  } finally { await f.close(); }
});
