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

  test('returns topics + junk verdict and sends an authorized chat/completions request', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeResponse('{"topics":["crypto","finance"],"junk":false,"junk_reason":""}')
    );
    const result = await classifyWithGemma('Will BTC hit 100k?', null, ['crypto', 'finance', 'sports']);
    expect(result).toEqual({ topics: ['crypto', 'finance'], junk: false, junkReason: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/v1\/chat\/completions$/);
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toMatch(/junk/);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('returns junk=true with reason for a flagged market', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeResponse('{"topics":["sports"],"junk":true,"junk_reason":"single match betting"}')
    );
    const result = await classifyWithGemma('Will Arsenal beat Chelsea on Sunday?', null, ['sports']);
    expect(result).toEqual({ topics: ['sports'], junk: true, junkReason: 'single match betting' });
  });

  test('returns junk=null when the junk field is missing or non-boolean', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse('{"topics":["science"]}'));
    let result = await classifyWithGemma('Vaccine question', null, ['science']);
    expect(result).toEqual({ topics: ['science'], junk: null, junkReason: null });

    global.fetch = jest.fn().mockResolvedValue(makeResponse('{"topics":["science"],"junk":"nope"}'));
    result = await classifyWithGemma('Vaccine question', null, ['science']);
    expect(result.junk).toBeNull();
  });

  test('retries once on 503 then succeeds', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeResponse('{"topics":["science"],"junk":false,"junk_reason":""}'));

    const result = await classifyWithGemma('Vaccine question', null, ['science', 'health']);
    expect(result.topics).toEqual(['science']);
    expect(result.junk).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('throws after both attempts fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    await expect(classifyWithGemma('test', null, ['science'])).rejects.toThrow('network error');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('returns empty topics and null junk when model output has no known fields', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse('{"result":"ok"}'));
    const result = await classifyWithGemma('test', null, ['science']);
    expect(result).toEqual({ topics: [], junk: null, junkReason: null });
  });

  test('strips ```json fences from the response content', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeResponse('```json\n{"topics":["sports"],"junk":false,"junk_reason":""}\n```')
    );
    const result = await classifyWithGemma('test', null, ['sports']);
    expect(result.topics).toEqual(['sports']);
    expect(result.junk).toBe(false);
  });
});
