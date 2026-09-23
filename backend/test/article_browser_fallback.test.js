jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../src/services/activitypub/ssrf', () => ({ assertSsrfSafeUrl: jest.fn(async (url) => new URL(url)) }));
jest.mock('../src/services/metadata/browserArticleClient', () => ({ fetchBrowserArticle: jest.fn() }));
jest.mock('jsdom', () => ({ JSDOM: jest.fn(() => ({ window: { document: {}, close: jest.fn() } })) }));
jest.mock('@mozilla/readability', () => ({ Readability: jest.fn() }));
const axios = require('axios');
const { Readability } = require('@mozilla/readability');
const { assertSsrfSafeUrl } = require('../src/services/activitypub/ssrf');
const { fetchBrowserArticle } = require('../src/services/metadata/browserArticleClient');
const { fetchArticleContent } = require('../src/services/metadata/metadataService');
const article = 'Readable article contents. '.repeat(20).trim();

beforeEach(() => {
  jest.clearAllMocks();
  assertSsrfSafeUrl.mockImplementation(async url => new URL(url));
  Readability.mockImplementation(() => ({ parse: () => ({ textContent: article }) }));
  fetchBrowserArticle.mockResolvedValue(article);
});
test('normal article retrieval never launches the browser', async () => {
  axios.get.mockResolvedValue({ status: 200, data: '<article>Text</article>' });
  expect(await fetchArticleContent('https://example.org/post')).toBe(article);
  expect(fetchBrowserArticle).not.toHaveBeenCalled();
});
test('HTTP rejection falls back to browser text', async () => {
  axios.get.mockRejectedValue(new Error('403 Forbidden'));
  expect(await fetchArticleContent('https://example.org/post')).toBe(article);
  expect(fetchBrowserArticle).toHaveBeenCalledWith('https://example.org/post', expect.any(AbortSignal));
});
test('empty extraction falls back, and failed browser retrieval stays unavailable', async () => {
  axios.get.mockResolvedValue({ status: 200, data: '<html></html>' });
  Readability.mockImplementation(() => ({ parse: () => null }));
  expect(await fetchArticleContent('https://example.org/post')).toBe(article);
  fetchBrowserArticle.mockRejectedValueOnce(new Error('unavailable'));
  expect(await fetchArticleContent('https://example.org/post')).toBeNull();
});
test('unsafe URL or redirect never reaches the browser', async () => {
  assertSsrfSafeUrl.mockRejectedValueOnce(new Error('SSRF blocked: private address'));
  expect(await fetchArticleContent('http://127.0.0.1/post')).toBeNull();
  axios.get.mockResolvedValue({ status: 302, headers: { location: 'http://127.0.0.1/post' } });
  assertSsrfSafeUrl.mockResolvedValueOnce(new URL('https://example.org/post')).mockResolvedValueOnce(new URL('https://example.org/post'))
    .mockRejectedValueOnce(new Error('SSRF blocked: private address'));
  expect(await fetchArticleContent('https://example.org/post')).toBeNull();
  expect(fetchBrowserArticle).not.toHaveBeenCalled();
});
test('browser shares the total deadline and receives cancellation', async () => {
  jest.useFakeTimers();
  try {
    axios.get.mockRejectedValue(new Error('403'));
    let signal;
    fetchBrowserArticle.mockImplementationOnce((url, abortSignal) => { signal = abortSignal; return new Promise(() => {}); });
    const result = fetchArticleContent('https://example.org/post', { timeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(100);
    expect(await result).toBeNull(); expect(signal.aborted).toBe(true);
  } finally { jest.useRealTimers(); }
});
