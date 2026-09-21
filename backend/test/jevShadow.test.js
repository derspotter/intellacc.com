jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const jev = require('../src/services/openRouterMatcher/jevShadow');

const candidates = [{ event_id: 42, title: 'Will rates fall by December?', details: 'Policy rate lower than today.', closing_date: '2026-12-31T00:00:00Z' }];
const input = { postId: 1, content: 'Rates will fall by December.', postContent: 'Rates will fall by December.', candidates };
const responseData = () => ({
  model: 'typesafe/jev-1.13',
  answers: {
    has_claim: { type: 'noul', noul: 0.97 },
    best_market: { type: 'choice', choice: 'market_42', confidence: 0.8, probabilities: { none: 0.1, market_42: 0.9 } },
    relevant_42: { type: 'noul', noul: 0.95 }
  },
  usage: { input_tokens: 400, output_tokens: 80, cost: 0.0000168 }
});
const response = (data = responseData()) => new Response(JSON.stringify(data));

beforeEach(() => {
  process.env.POST_SIGNAL_JEV_MODE = 'shadow';
  process.env.OPENROUTER_API_KEY = 'secret-test-key';
  delete process.env.POST_SIGNAL_JEV_MODEL;
  db.query.mockReset().mockResolvedValue({ rows: [{ id: 1, shadow_table: 'post_match_jev_shadow' }] });
});
afterEach(() => {
  delete process.env.POST_SIGNAL_JEV_MODE;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.POST_SIGNAL_JEV_MODEL;
  jest.useRealTimers();
});

test.each([undefined, 'off', 'enabled', 'SHADOW'])('mode %s makes no API or database calls', async (mode) => {
  if (mode === undefined) delete process.env.POST_SIGNAL_JEV_MODE;
  else process.env.POST_SIGNAL_JEV_MODE = mode;
  const fetchImpl = jest.fn();
  expect(await jev.evaluate(input, { fetchImpl })).toBeNull();
  expect(db.query).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('missing key records a skip without making requests', async () => {
  delete process.env.OPENROUTER_API_KEY;
  const fetchImpl = jest.fn();
  expect(await jev.evaluate(input, { fetchImpl })).toMatchObject({ status: 'skipped', error_code: 'missing_key' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('sends exact market metadata, a none choice, and validates typed decisions', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(response());
  const result = await jev.evaluate(input, { fetchImpl });
  expect(result).toMatchObject({ status: 'ok', provider: 'openrouter', used_model: 'typesafe/jev-1.13', input_tokens: 400, cost_usd: 0.0000168, candidates });
  const [url, options] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
  expect(options.redirect).toBe('error');
  expect(options.headers.Authorization).toBe('Bearer secret-test-key');
  const request = JSON.parse(options.body);
  expect(request.model).toBe('typesafe/jev-1.13');
  expect(request.questions.best_market.criteria).toMatchObject({ none: expect.any(String), market_42: expect.any(String) });
  expect(request.state.markets).toEqual(candidates);
  expect(JSON.stringify(result)).not.toContain('secret-test-key');
  expect(JSON.stringify(result)).not.toContain(input.content);
  expect(result.answers.has_claim.noul).toBe(0.97);
});

test('missing migration skips paid calls', async () => {
  db.query.mockResolvedValue({ rows: [{ id: 1, shadow_table: null }] });
  const fetchImpl = jest.fn();
  expect(await jev.evaluate(input, { fetchImpl })).toMatchObject({ error_code: 'missing_schema' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('no candidates still evaluates claim presence without inventing a match', async () => {
  const data = responseData();
  data.answers = { has_claim: data.answers.has_claim };
  const fetchImpl = jest.fn().mockResolvedValue(response(data));
  expect(await jev.evaluate({ ...input, candidates: [] }, { fetchImpl })).toMatchObject({ status: 'ok' });
  expect(Object.keys(JSON.parse(fetchImpl.mock.calls[0][1].body).questions)).toEqual(['has_claim']);
});

test('private, deleted, edited or non-top-level posts are not sent', async () => {
  db.query.mockResolvedValue({ rows: [] });
  const fetchImpl = jest.fn();
  expect(await jev.evaluate(input, { fetchImpl })).toMatchObject({ error_code: 'ineligible_post' });
  expect(db.query.mock.calls[0][0]).toMatchObject({
    text: expect.stringContaining('community_group_id IS NULL AND parent_id IS NULL'), values: [1, input.content]
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([
  (data) => { data.answers.has_claim.noul = '0.9'; },
  (data) => { data.answers.has_claim.noul = null; },
  (data) => { data.answers.relevant_42.noul = 1.01; },
  (data) => { data.answers.best_market.choice = 'market_999'; },
  (data) => { data.answers.best_market.confidence = -1; },
  (data) => { data.answers.best_market.probabilities.none = 0.4; },
  (data) => { data.answers.best_market.probabilities = { none: 0.9, market_42: 0.1 }; },
  (data) => { delete data.answers.relevant_42; }
])('malformed provider decision is contained', async (mutate) => {
  const data = responseData(); mutate(data);
  const result = await jev.evaluate(input, { fetchImpl: jest.fn().mockResolvedValue(response(data)) });
  expect(result).toMatchObject({ status: 'error', error_code: 'invalid_response' });
  expect(result.answers).toBeUndefined();
  expect(result.error_field).toEqual(expect.any(String));
});

test('valid uncertainty and none are preserved without thresholding into a link', async () => {
  const data = responseData();
  data.answers.best_market = { type: 'choice', choice: 'none', confidence: 0.01, probabilities: { none: 0.51, market_42: 0.49 } };
  const result = await jev.evaluate(input, { fetchImpl: jest.fn().mockResolvedValue(response(data)) });
  expect(result.answers.best_market).toEqual(data.answers.best_market);
});

test('OpenRouter two-decimal rounding is accepted without changing the distribution', () => {
  const { request } = jev.buildRequest(input.content, [...candidates, { event_id: 43, title: 'Rates rise?' }], 'typesafe/jev-1.13');
  const data = responseData();
  data.answers.best_market = { type: 'choice', choice: 'none', confidence: 0, probabilities: { none: 0.33, market_42: 0.33, market_43: 0.33 } };
  data.answers.relevant_43 = { type: 'noul', noul: 0.5 };
  expect(jev.parseResponse(data, request).answers.best_market.probabilities).toEqual(data.answers.best_market.probabilities);
  data.answers.best_market.probabilities = { none: 0.3, market_42: 0.3, market_43: 0.3 };
  expect(() => jev.parseResponse(data, request)).toThrow('invalid_response');
});

test.each([undefined, null, '0.01', -1, Infinity])('missing or invalid OpenRouter cost %s remains unknown', (cost) => {
  const { request } = jev.buildRequest(input.content, candidates, 'typesafe/jev-1.13');
  const data = responseData();
  data.usage.cost = cost;
  expect(jev.parseResponse(data, request).cost_usd).toBeNull();
});

test('OpenRouter returns a resolved model version and zero cost is valid', () => {
  const { request } = jev.buildRequest(input.content, candidates, 'typesafe/jev-1.13');
  const data = responseData();
  data.model = 'typesafe/jev-1.13-20260917';
  data.usage.cost = 0;
  expect(jev.parseResponse(data, request)).toMatchObject({ used_model: data.model, cost_usd: 0 });
});

test('oversized input, too many and duplicate candidates skip before requests', async () => {
  const fetchImpl = jest.fn();
  expect(await jev.evaluate({ ...input, postContent: 'a'.repeat(jev.LIMITS.inputBytes) }, { fetchImpl })).toMatchObject({ error_code: 'input_too_large' });
  expect(await jev.evaluate({ ...input, candidates: Array(16).fill(candidates[0]) }, { fetchImpl })).toMatchObject({ error_code: 'too_many_candidates' });
  expect(await jev.evaluate({ ...input, candidates: [candidates[0], candidates[0]] }, { fetchImpl })).toMatchObject({ error_code: 'invalid_candidate' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('oversized response is rejected', async () => {
  expect(await jev.evaluate(input, { fetchImpl: jest.fn().mockResolvedValue(new Response('x'.repeat(jev.LIMITS.responseBytes + 1))) }))
    .toMatchObject({ status: 'error', error_code: 'response_too_large' });
});

test('429 and network errors are redacted and never retried', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(new Response('sensitive body', { status: 429 }));
  expect(await jev.evaluate(input, { fetchImpl })).toMatchObject({ error_code: 'rate_limited' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  fetchImpl.mockRejectedValue(new Error('secret-test-key provider detail'));
  const result = await jev.evaluate(input, { fetchImpl });
  expect(result.error_code).toBe('provider_error');
  expect(JSON.stringify(result)).not.toContain('secret-test-key');
});

test('request timeout releases concurrency slot', async () => {
  jest.useFakeTimers();
  const fetchImpl = jest.fn((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const pending = jev.evaluate(input, { fetchImpl });
  await jest.advanceTimersByTimeAsync(jev.LIMITS.timeoutMs + 1);
  expect(await pending).toMatchObject({ error_code: 'timeout' });
  expect(await jev.evaluate(input, { fetchImpl: jest.fn().mockResolvedValue(response()) })).toMatchObject({ status: 'ok' });
});

test('timeout also aborts a stalled response body', async () => {
  jest.useFakeTimers();
  const fetchImpl = jest.fn(async (url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
    }
  })));
  const pending = jev.evaluate(input, { fetchImpl });
  await jest.advanceTimersByTimeAsync(jev.LIMITS.timeoutMs + 1);
  expect(await pending).toMatchObject({ error_code: 'timeout' });
});

test('daily allowance limits attempts and resets on the next UTC day', async () => {
  jest.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z') });
  const fetchImpl = jest.fn(async () => response());
  for (let i = 0; i < jev.LIMITS.dailyCalls; i += 1) {
    expect((await jev.evaluate(input, { fetchImpl })).status).toBe('ok');
  }
  expect(await jev.evaluate(input, { fetchImpl })).toMatchObject({ error_code: 'daily_limit' });
  expect(fetchImpl).toHaveBeenCalledTimes(jev.LIMITS.dailyCalls);
  jest.setSystemTime(new Date('2030-01-02T00:00:00Z'));
  expect((await jev.evaluate(input, { fetchImpl })).status).toBe('ok');
});

test('concurrency saturation skips instead of queueing unbounded requests', async () => {
  const releases = [];
  const fetchImpl = jest.fn(() => new Promise((resolve) => releases.push(() => resolve(response()))));
  const one = jev.evaluate(input, { fetchImpl });
  const two = jev.evaluate(input, { fetchImpl });
  await Promise.resolve();
  expect(await jev.evaluate(input, { fetchImpl })).toMatchObject({ error_code: 'busy' });
  releases.forEach((release) => release());
  await Promise.all([one, two]);
});
