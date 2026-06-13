// backend/test/qwen_classifier.test.js
// Unit tests for qwenClassifier — mocks global fetch to avoid hitting the real service.
process.env.QWEN_CLASSIFIER_RETRY_MS = '1'; // make retry near-instant

// Must be set before requiring the module so the default picks up the env.
const { classifyWithQwen } = require('../src/services/qwenClassifier');

jest.setTimeout(10000);

const makeResponse = (topics) => ({
  ok: true,
  json: async () => ({ response: JSON.stringify({ topics }), done: true })
});

const makeErrorResponse = (status) => ({
  ok: false,
  status,
  text: async () => `error ${status}`
});

describe('classifyWithQwen', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns topics array on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse(['crypto', 'finance']));
    const result = await classifyWithQwen('Will BTC hit 100k?', null, ['crypto', 'finance', 'sports']);
    expect(result).toEqual(['crypto', 'finance']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('retries once on 503 then succeeds', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeResponse(['science']));

    const result = await classifyWithQwen('Vaccine question', null, ['science', 'health']);
    expect(result).toEqual(['science']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('throws after both attempts fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    await expect(classifyWithQwen('test', null, ['science'])).rejects.toThrow('network error');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('returns [] when model returns no topics field', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"result": "ok"}', done: true })
    });
    const result = await classifyWithQwen('test', null, ['science']);
    expect(result).toEqual([]);
  });

  test('strips ```json fences from response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '```json\n{"topics":["sports"]}\n```', done: true })
    });
    const result = await classifyWithQwen('test', null, ['sports']);
    expect(result).toEqual(['sports']);
  });

  test('handles an already-parsed object response (format:json)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: { topics: ['health'] }, done: true })
    });
    const result = await classifyWithQwen('test', null, ['health', 'science']);
    expect(result).toEqual(['health']);
  });
});
