const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

const publicAddress = (address) => {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
};
const validateUrl = (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) || value.length > 4096) {
    throw new Error('Unsupported article URL');
  }
  return url;
};
// Validate ALL answers, then connect to the checked numeric IP, never resolving
// the hostname a second time. This applies to every redirect and connection.
const resolvePublic = async (hostname, lookup = dns.lookup) => {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Private destination');
  const answers = net.isIP(host) ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(({ address }) => !publicAddress(address))) throw new Error('Private destination');
  return answers[0];
};

const createPublicProxy = async ({ maxBytes = 12 * 1024 * 1024, lookup = dns.lookup } = {}) => {
  const sockets = new Set();
  let bytes = 0;
  let closed = false;
  let closing;
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) for (const active of sockets) active.destroy();
    });
    socket.setTimeout(15000, () => socket.destroy());
    return socket;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = validateUrl(req.url);
      if (url.protocol !== 'http:' || req.method !== 'GET') throw new Error('Unsupported request');
      const target = await resolvePublic(url.hostname, lookup);
      if (closed || bytes > maxBytes) throw new Error('Reader closed');
      const headers = { ...req.headers, host: url.host, connection: 'close' };
      delete headers['proxy-authorization'];
      const upstream = http.request({ host: target.address, family: target.family, port: 80,
        path: url.pathname + url.search, method: 'GET', headers }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.on('error', () => res.destroy());
      req.on('aborted', () => upstream.destroy());
      upstream.end();
    } catch { res.writeHead(403); res.end(); }
  });
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    try {
      const url = validateUrl(`https://${req.url}`);
      if (url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid tunnel');
      const target = await resolvePublic(url.hostname, lookup);
      if (closed || bytes > maxBytes) throw new Error('Reader closed');
      const upstream = track(net.connect({ host: target.address, family: target.family, port: 443 }));
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      if (closing) return closing;
      closed = true;
      for (const socket of sockets) socket.destroy();
      closing = new Promise((resolve) => server.close(resolve));
      return closing;
    }
  };
};
module.exports = { publicAddress, validateUrl, resolvePublic, createPublicProxy };
