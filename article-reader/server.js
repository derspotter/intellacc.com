const http = require('node:http');
const { readArticle } = require('./reader');

const createServer = (read = readArticle, { timeoutMs = 20000 } = {}) => {
  let active = 0;
  return http.createServer(async (req, res) => {
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } };
    if (req.url === '/health' && req.method === 'GET') return reply(200, { ok: true });
    if (req.url !== '/read' || req.method !== 'POST') return reply(404, { error: 'not_found' });
    if (active >= 2) return reply(503, { error: 'busy' });
    active += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(); reply(504, { error: 'timeout' });
      if (!req.complete) req.destroy();
    }, timeoutMs);
    req.setTimeout(5000, () => req.destroy());
    res.on('close', () => controller.abort());
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw new Error('Request too large');
      }
      const { url } = JSON.parse(body);
      if (typeof url !== 'string') throw new Error('Missing URL');
      const result = await read(url, { signal: controller.signal });
      if (!controller.signal.aborted) reply(200, result);
    } catch {
      if (!controller.signal.aborted) reply(422, { error: 'article_unavailable' });
    } finally { clearTimeout(timer); active -= 1; }
  });
};
if (require.main === module) createServer().listen(3012, '0.0.0.0');
module.exports = { createServer };
