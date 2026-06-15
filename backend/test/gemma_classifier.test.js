// backend/test/gemma_classifier.test.js
// Unit tests for gemmaClassifier — mocks global fetch to avoid hitting the real
// OpenAI-compatible Gemma endpoint.
process.env.GEMMA_CLASSIFIER_RETRY_MS = '1'; // make retry near-instant
process.env.GEMMA_API_KEY = 'test-key';

const { classifyWithGemma } = require('../src/services/gemmaClassifier');

jest.setTimeout(10000);

// OpenAI chat/completions success envelope: content is the assistant string.
const makeResponse = (content) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] })
});

const makeErrorResponse = (status) => ({
  ok: false,
  status,
  text: async () => `error ${status}`
});

describe('classifyWithGemma', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns topics array and sends an authorized chat/completions request', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse('{"topics":["crypto","finance"]}'));
    const result = await classifyWithGemma('Will BTC hit 100k?', null, ['crypto', 'finance', 'sports']);
    expect(result).toEqual(['crypto', 'finance']);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/v1\/chat\/completions$/);
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.messages[0].role).toBe('user');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('retries once on 503 then succeeds', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeResponse('{"topics":["science"]}'));

    const result = await classifyWithGemma('Vaccine question', null, ['science', 'health']);
    expect(result).toEqual(['science']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('throws after both attempts fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    await expect(classifyWithGemma('test', null, ['science'])).rejects.toThrow('network error');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('returns [] when model output has no topics field', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse('{"result":"ok"}'));
    const result = await classifyWithGemma('test', null, ['science']);
    expect(result).toEqual([]);
  });

  test('strips ```json fences from the response content', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse('```json\n{"topics":["sports"]}\n```'));
    const result = await classifyWithGemma('test', null, ['sports']);
    expect(result).toEqual(['sports']);
  });
});
