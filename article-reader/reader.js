const fs = require('node:fs');
const { chromium } = require('playwright');
const { validateUrl, createPublicProxy } = require('./publicProxy');
const readability = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const MAX_TEXT = 100000;

const readArticle = async (url, { signal } = {}) => {
  validateUrl(url);
  const proxy = await createPublicProxy();
  let browser;
  const abort = () => { void browser?.close().catch(() => {}); void proxy.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Reader cancelled');
    browser = await chromium.launch({ headless: true, timeout: 8000,
      proxy: { server: proxy.url, bypass: '<-loopback>' }, args: ['--disable-quic'] });
    if (signal?.aborted) throw new Error('Reader cancelled');
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    // Article HTML only: no site scripts, images, trackers, subframes or APIs.
    await context.route('**/*', (route) => {
      const req = route.request();
      let allowed = false;
      try { validateUrl(req.url()); allowed = req.method() === 'GET' && req.isNavigationRequest() && req.frame() === page.mainFrame(); } catch { /* Reject. */ }
      return allowed ? route.continue() : route.abort();
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    let decodedBytes = 0;
    cdp.on('Network.dataReceived', ({ dataLength }) => {
      decodedBytes += dataLength;
      if (decodedBytes > 5 * 1024 * 1024) void context.close().catch(() => {});
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (!response || response.status() !== 200) throw new Error('Article unavailable');
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers()['content-type'] || '')) throw new Error('Not an HTML article');
    // Evaluate only our extractor. Website JavaScript remains disabled.
    await page.evaluate(readability);
    const result = await page.evaluate((limit) => {
      const article = new Readability(document.cloneNode(true)).parse();
      return { text: article?.textContent?.replace(/\n\s*\n/g, '\n\n').trim().slice(0, limit) || null, url: location.href };
    }, MAX_TEXT);
    if (!result.text || result.text.length < 100) throw new Error('No readable article');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser?.close().catch(() => {});
    await proxy.close();
  }
};
module.exports = { readArticle };
