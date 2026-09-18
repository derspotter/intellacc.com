jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../src/services/activitypub/ssrf', () => ({ assertSsrfSafeUrl: jest.fn() }));
jest.mock('metascraper', () => () => jest.fn().mockResolvedValue({ title: 'Page' }));

const axios = require('axios');
const { assertSsrfSafeUrl } = require('../src/services/activitypub/ssrf');
const { fetchMetadata } = require('../src/services/metadata/metadataService');

describe('metadata total deadline and redirect checks', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    axios.get.mockReset();
    assertSsrfSafeUrl.mockReset().mockImplementation(async (url) => new URL(url));
  });
  afterEach(() => jest.useRealTimers());

  test('checks each redirect before fetching it', async () => {
    axios.get.mockResolvedValueOnce({ status: 302, headers: { location: '/next' } })
      .mockResolvedValueOnce({ status: 200, data: '<title>Page</title>' });
    expect(await fetchMetadata('https://example.test/start')).toMatchObject({ url: 'https://example.test/next', title: 'Page' });
    expect(assertSsrfSafeUrl.mock.calls.map(([url]) => url)).toEqual(['https://example.test/start', 'https://example.test/next']);
    expect(axios.get.mock.calls[0][1].maxRedirects).toBe(0);
  });

  test('does not fetch a redirect rejected by SSRF validation', async () => {
    axios.get.mockResolvedValue({ status: 302, headers: { location: 'http://127.0.0.1/private' } });
    assertSsrfSafeUrl.mockResolvedValueOnce(new URL('https://example.test/start'))
      .mockRejectedValueOnce(new Error('SSRF blocked: private address'));
    expect(await fetchMetadata('https://example.test/start')).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('all redirect hops share one deadline and abort the outstanding request', async () => {
    let signal;
    axios.get.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ status: 302, headers: { location: '/slow' } }), 60)))
      .mockImplementationOnce((url, options) => {
        signal = options.signal;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      });
    const result = fetchMetadata('https://example.test/start', { timeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(99);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(signal.aborted).toBe(true);
  });

  test('a stalled DNS check is bounded by the same deadline', async () => {
    assertSsrfSafeUrl.mockImplementation(() => new Promise(() => {}));
    const result = fetchMetadata('https://example.test/start', { timeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(100);
    expect(await result).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('the worker can retain errors without changing the default null fallback', async () => {
    assertSsrfSafeUrl.mockRejectedValue(new Error('DNS lookup failed'));
    await expect(fetchMetadata('https://example.test/start', { throwOnError: true })).rejects.toThrow('DNS lookup failed');
    expect(await fetchMetadata('https://example.test/start')).toBeNull();
  });
});
