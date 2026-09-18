// Provider client: fixed hosts, request shapes, response parsing and
// sanitized error mapping. No network: fetch is injected.
const providers = require('../src/services/ai/providers');

const { complete, buildRequest, PROVIDERS, PROVIDER_IDS, AiProviderError, LIMITS } = providers;
const KEY = 'sk-test-secret-key-0000000000';
const SECRET_BODY = 'SUPER_SECRET_PROVIDER_BODY';
const base = { apiKey: KEY, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] };

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  body: null,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});
const fetchReturning = (status, body, headers) => jest.fn(async () => response(status, body, headers));
const bodyOf = (fetchImpl) => JSON.parse(fetchImpl.mock.calls[0][1].body);
const optionsOf = (fetchImpl) => fetchImpl.mock.calls[0][1];

describe('fixed provider endpoints', () => {
  test('every provider targets a fixed HTTPS host and nothing else', () => {
    const hosts = { openrouter: 'openrouter.ai', openai: 'api.openai.com', anthropic: 'api.anthropic.com', xai: 'api.x.ai' };
    expect([...PROVIDER_IDS].sort()).toEqual(Object.keys(hosts).sort());
    for (const id of PROVIDER_IDS) {
      const url = new URL(PROVIDERS[id].url);
      expect(url.protocol).toBe('https:');
      expect(url.host).toBe(hosts[id]);
    }
  });

  test('a caller-supplied base URL is ignored and redirects are errors', async () => {
    const fetchImpl = fetchReturning(200, { choices: [{ message: { content: 'ok' } }] });
    await complete({ ...base, provider: 'xai', model: 'grok-test', baseUrl: 'https://evil.example/v1' }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
    const options = optionsOf(fetchImpl);
    expect(options.redirect).toBe('error');
    expect(options.method).toBe('POST');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('request shapes', () => {
  test('OpenAI uses the Responses API with store:false, instructions and role input', async () => {
    const fetchImpl = fetchReturning(200, {
      model: 'gpt-test-2',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello ' }, { type: 'output_text', text: 'there' }] }
      ]
    });
    const result = await complete({
      ...base, provider: 'openai', model: 'gpt-test',
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]
    }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    const options = optionsOf(fetchImpl);
    expect(options.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = bodyOf(fetchImpl);
    expect(body).toMatchObject({ model: 'gpt-test', store: false, instructions: 'be brief' });
    expect(body.input).toEqual([
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }
    ]);
    expect(body.max_output_tokens).toBeLessThanOrEqual(LIMITS.maxOutputTokens);
    expect(body.tools).toBeUndefined();
    expect(result).toEqual({ text: 'Hello there', model: 'gpt-test-2' });
  });

  test('Anthropic sends system separately with max_tokens and the pinned API version', async () => {
    const fetchImpl = fetchReturning(200, { model: 'claude-test', content: [{ type: 'text', text: 'Hi' }] });
    const result = await complete({ ...base, provider: 'anthropic', model: 'claude-test' }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    const options = optionsOf(fetchImpl);
    expect(options.headers['x-api-key']).toBe(KEY);
    expect(options.headers['anthropic-version']).toBe('2023-06-01');
    expect(options.headers.authorization).toBeUndefined();
    const body = bodyOf(fetchImpl);
    expect(body.system).toBe('be brief');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(typeof body.max_tokens).toBe('number');
    expect(body.tools).toBeUndefined();
    expect(result).toEqual({ text: 'Hi', model: 'claude-test' });
  });

  test.each(['openrouter', 'xai'])('%s uses chat completions with a leading system message', async (provider) => {
    const fetchImpl = fetchReturning(200, { choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'Yo' }] } }] });
    const result = await complete({ ...base, provider, model: 'vendor/model-1' }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(PROVIDERS[provider].url);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/v1\/chat\/completions$/);
    const body = bodyOf(fetchImpl);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(body.tools).toBeUndefined();
    expect(result.text).toBe('Yo');
    expect(result.model).toBe('vendor/model-1');
  });

  test('turns are normalized: leading assistant dropped, same-role turns merged', () => {
    const request = buildRequest({
      provider: 'anthropic', model: 'm', apiKey: KEY, system: 's',
      messages: [{ role: 'assistant', content: 'stray' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'c' }]
    });
    expect(JSON.parse(request.body).messages).toEqual([
      { role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'c' }
    ]);
  });
});

describe('validation before any network call', () => {
  test.each([
    ['unknown provider', { ...base, provider: 'gemini', model: 'm' }, 'not_configured'],
    ['empty model', { ...base, provider: 'openai', model: '' }, 'invalid_model'],
    ['model with spaces', { ...base, provider: 'openai', model: 'gpt 5' }, 'invalid_model'],
    ['model too long', { ...base, provider: 'openai', model: 'a'.repeat(129) }, 'invalid_model'],
    ['model with query characters', { ...base, provider: 'openai', model: 'm?x=1' }, 'invalid_model'],
    ['missing key', { ...base, provider: 'openai', model: 'm', apiKey: '' }, 'not_configured'],
    ['key with whitespace', { ...base, provider: 'openai', model: 'm', apiKey: 'sk bad key value' }, 'not_configured']
  ])('%s is rejected without calling fetch', async (_label, input, code) => {
    const fetchImpl = jest.fn();
    await expect(complete(input, { fetchImpl })).rejects.toMatchObject({ code });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a prompt above the request bound is rejected', async () => {
    const fetchImpl = jest.fn();
    const huge = 'x'.repeat(LIMITS.maxRequestChars + 10);
    await expect(complete({ ...base, provider: 'openai', model: 'm', messages: [{ role: 'user', content: huge }] }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'bad_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('error mapping never leaks provider bodies, prompts or keys', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  test.each([
    [401, 'auth'], [403, 'auth'], [404, 'model_not_found'], [429, 'rate_limited'], [402, 'billing'], [400, 'bad_request'], [500, 'upstream'], [503, 'upstream']
  ])('HTTP %i maps to %s', async (status, code) => {
    const fetchImpl = fetchReturning(status, { error: { message: SECRET_BODY } });
    let caught;
    try {
      await complete({ ...base, provider: 'openai', model: 'm', messages: [{ role: 'user', content: 'MY PROMPT TEXT' }] }, { fetchImpl });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AiProviderError);
    expect(caught.code).toBe(code);
    expect(caught.status).toBe(status);
    const surfaced = `${caught.message} ${JSON.stringify(caught)}`;
    expect(surfaced).not.toContain(SECRET_BODY);
    expect(surfaced).not.toContain(KEY);
    expect(surfaced).not.toContain('MY PROMPT TEXT');
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).not.toContain(SECRET_BODY);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('MY PROMPT TEXT');
  });

  test('unparseable, empty and oversized responses are distinct safe errors', async () => {
    await expect(complete({ ...base, provider: 'openai', model: 'm' }, { fetchImpl: fetchReturning(200, 'not json <html>') }))
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(complete({ ...base, provider: 'openai', model: 'm' }, { fetchImpl: fetchReturning(200, { output: [] }) }))
      .rejects.toMatchObject({ code: 'empty_response' });
    await expect(complete({ ...base, provider: 'anthropic', model: 'm' }, { fetchImpl: fetchReturning(200, { type: 'error', error: { message: SECRET_BODY } }) }))
      .rejects.toMatchObject({ code: 'upstream' });
    await expect(complete({ ...base, provider: 'openai', model: 'm' }, { fetchImpl: fetchReturning(200, { output: [] }, { 'content-length': String(LIMITS.maxResponseBytes + 1) }) }))
      .rejects.toMatchObject({ code: 'response_too_large' });
    const oversized = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(LIMITS.maxResponseBytes + 1) } }] });
    await expect(complete({ ...base, provider: 'xai', model: 'm' }, { fetchImpl: fetchReturning(200, oversized) }))
      .rejects.toMatchObject({ code: 'response_too_large' });
  });

  test('an over-long assistant text is truncated, not rejected', async () => {
    const fetchImpl = fetchReturning(200, { choices: [{ message: { content: 'y'.repeat(LIMITS.maxAssistantChars + 500) } }] });
    const result = await complete({ ...base, provider: 'openrouter', model: 'm' }, { fetchImpl });
    expect(result.text.length).toBeLessThan(LIMITS.maxAssistantChars + 50);
    expect(result.text).toMatch(/\[response truncated\]$/);
  });

  test('a hung provider is aborted and reported as a timeout, not retried', async () => {
    const fetchImpl = jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    await expect(complete({ ...base, provider: 'openai', model: 'm' }, { fetchImpl, timeoutMs: 30 }))
      .rejects.toMatchObject({ code: 'timeout', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('connection failures map to network', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error(`ECONNREFUSED ${SECRET_BODY}`); });
    let caught;
    try { await complete({ ...base, provider: 'openai', model: 'm' }, { fetchImpl }); } catch (error) { caught = error; }
    expect(caught.code).toBe('network');
    expect(caught.message).not.toContain(SECRET_BODY);
  });
});
