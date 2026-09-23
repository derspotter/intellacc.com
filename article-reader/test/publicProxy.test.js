const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { publicAddress, validateUrl, resolvePublic, createPublicProxy } = require('../publicProxy');

test('rejects private, special, mapped and nonstandard destinations', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.17.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['file:///etc/passwd', 'http://example.com:3000', 'https://example.com:80', 'https://user:pass@example.com']) assert.throws(() => validateUrl(url));
  for (const url of ['http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]']) {
    await assert.rejects(resolvePublic(validateUrl(url).hostname), /Private/);
  }
});

test('rejects mixed public/private DNS answers and returns the checked IP', async () => {
  await assert.rejects(resolvePublic('example.test', async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]), /Private/);
  let calls = 0;
  const target = await resolvePublic('example.test', async () => { calls += 1; return [{ address: '1.1.1.1', family: 4 }]; });
  assert.deepEqual(target, { address: '1.1.1.1', family: 4 });
  assert.equal(calls, 1);
});

test('proxy blocks HTTP and HTTPS tunnels to internal addresses, then closes cleanly', async () => {
  const proxy = await createPublicProxy();
  try {
    const endpoint = new URL(proxy.url);
    const status = await new Promise((resolve, reject) => {
      http.get({ hostname: endpoint.hostname, port: endpoint.port, path: 'http://127.0.0.1:80/private' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
    const connectStatus = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: endpoint.hostname, port: endpoint.port, method: 'CONNECT', path: '[::ffff:127.0.0.1]:443' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(connectStatus, 403);
  } finally { await proxy.close(); await proxy.close(); }
});
