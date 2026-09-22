jest.mock('../src/services/openRouterMatcher/llmClient', () => ({ callLLMWithFallback: jest.fn() }));
jest.mock('../src/services/openRouterMatcher/config', () => ({
  isEnabled: true, openRouterApiKey: 'test', reasoner: {
    enabled: true, model: 'openai/gpt-6-luna', fallbackModels: ['deepseek/deepseek-v4.1-flash'],
    maxTokens: 2500, temperature: 0, timeoutMs: 20000, reasoningMaxTokens: 256
  }
}));
const { callLLMWithFallback } = require('../src/services/openRouterMatcher/llmClient');
const { runSafeReasoner } = require('../src/services/openRouterMatcher/argumentExtractor');
const input = { postContent: 'MrBeast will not win the 2028 Democratic presidential nomination!',
  candidates: [{ event_id: 1653, title: 'Will MrBeast win the 2028 Democratic presidential nomination?' }] };
const valid = () => ({
  best_market: { event_id: 1653, stance: 'disagrees', confidence: 0.99, reasoning: 'The post predicts the negative outcome.' },
  propositions: [{ label: 'P1', type: 'conclusion', content: input.postContent, formal: null, confidence_level: 'prediction', negated: true }],
  relations: [], conditional_flags: [], critiques: []
});
const empty = () => ({ best_market: null, propositions: [], relations: [], conditional_flags: [], critiques: [] });
beforeEach(() => callLLMWithFallback.mockReset());

test('DeepSeek uses low effort while Luna retains the existing reasoning budget', async () => {
  callLLMWithFallback.mockResolvedValueOnce({ output: valid() });
  await runSafeReasoner(input);
  const [options] = callLLMWithFallback.mock.calls[0];
  expect(options.extraParams.reasoning).toEqual({ enabled: true, max_tokens: 256 });
  expect(options.extraParamsByModel).toEqual({
    'deepseek/deepseek-v4.1-flash': { reasoning: { effort: 'low' } }
  });
});

test('schema-free recovery retains the full contract and correctly matches a negated prediction', async () => {
  callLLMWithFallback.mockRejectedValueOnce(new Error('No endpoints found matching your data policy'))
    .mockResolvedValueOnce({ output: valid() });
  const result = await runSafeReasoner(input);
  expect(result.best_market).toMatchObject({ event_id: 1653, stance: 'disagrees' });
  expect(callLLMWithFallback).toHaveBeenCalledTimes(2);
  const [options] = callLLMWithFallback.mock.calls[1];
  expect(options.extraParams.response_format).toBeUndefined();
  expect(options.messages[0].content).toContain('"required":["event_id","stance","confidence","reasoning"]');
  expect(options.messages[0].content).toContain('never a bare');
});

test.each([1653, '1653'])('scalar best_market %s causes a repair, not a no-match result', async (best_market) => {
  callLLMWithFallback.mockResolvedValueOnce({ output: { ...valid(), best_market } })
    .mockResolvedValueOnce({ output: valid() });
  expect((await runSafeReasoner(input)).best_market.event_id).toBe(1653);
  expect(callLLMWithFallback).toHaveBeenCalledTimes(2);
});

test('repeated malformed recovery output raises a diagnostic error with no fabricated stance', async () => {
  callLLMWithFallback.mockRejectedValueOnce(new Error('No endpoints found matching your data policy'))
    .mockResolvedValueOnce({ output: { best_market: 1653, confidence: 0.99 } });
  await expect(runSafeReasoner(input)).rejects.toMatchObject({ code: 'MATCH_REASONER_INVALID_OUTPUT', message: 'Invalid reasoner output at best_market' });
  expect(callLLMWithFallback).toHaveBeenCalledTimes(2);
});

test('explicit valid no-match is accepted once without salvage requests', async () => {
  callLLMWithFallback.mockResolvedValue({ output: empty() });
  expect(await runSafeReasoner(input)).toEqual(empty());
  expect(callLLMWithFallback).toHaveBeenCalledTimes(1);
});

test.each([
  (r) => { r.best_market.event_id = 999; },
  (r) => { r.best_market.event_id = '1653junk'; },
  (r) => { r.best_market.stance = 'disagree'; },
  (r) => { r.best_market.confidence = null; },
  (r) => { r.best_market.confidence = 1.5; },
  (r) => { r.best_market.reasoning = ''; },
  (r) => { delete r.best_market; },
  (r) => { delete r.conditional_flags; },
  (r) => { r.propositions = [{ text: 'Missing all required proposition fields' }]; },
  (r) => { r.propositions[0].content = ' '; },
  (r) => { r.propositions.push({ ...r.propositions[0] }); },
  (r) => { r.relations = [{ from: 'P1', to: 'unknown', type: 'supports' }]; },
  (r) => { r.critiques = [{ type: 'unsupported_assumption', reasoning: 'No required description or severity' }]; }
])('invalid output cannot silently become an empty successful analysis', async (mutate) => {
  const raw = valid(); mutate(raw);
  callLLMWithFallback.mockResolvedValue({ output: raw });
  await expect(runSafeReasoner(input)).rejects.toMatchObject({ code: 'MATCH_REASONER_INVALID_OUTPUT' });
  expect(callLLMWithFallback).toHaveBeenCalledTimes(2);
});

test('valid null match does not hide malformed critique fields', async () => {
  callLLMWithFallback.mockResolvedValue({ output: { ...empty(), critiques: [{ description: 'lost' }] } });
  await expect(runSafeReasoner(input)).rejects.toMatchObject({ code: 'MATCH_REASONER_INVALID_OUTPUT' });
});

test.each([new SyntaxError('provider output'), new Error('Empty model output')])('invalid JSON and empty content receive one bounded repair', async (error) => {
  callLLMWithFallback.mockRejectedValueOnce(error).mockResolvedValueOnce({ output: valid() });
  expect((await runSafeReasoner(input)).best_market.event_id).toBe(1653);
  expect(callLLMWithFallback).toHaveBeenCalledTimes(2);
});

test('transport errors are not multiplied by format-repair retries', async () => {
  const error = new Error('Provider unavailable');
  callLLMWithFallback.mockRejectedValue(error);
  await expect(runSafeReasoner(input)).rejects.toBe(error);
  expect(callLLMWithFallback).toHaveBeenCalledTimes(1);
});

test('malformed text is not echoed in the repair prompt', async () => {
  callLLMWithFallback.mockResolvedValueOnce({ output: { unexpected: 'UNTRUSTED_PROVIDER_TEXT' } })
    .mockResolvedValueOnce({ output: valid() });
  await runSafeReasoner(input);
  expect(JSON.stringify(callLLMWithFallback.mock.calls[1][0].messages)).not.toContain('UNTRUSTED_PROVIDER_TEXT');
});

test('the platform-funded reasoner refuses public critique requests', async () => {
  await expect(runSafeReasoner({ ...input, purpose: 'critique' })).rejects.toThrow('user-funded critique service');
  expect(callLLMWithFallback).not.toHaveBeenCalled();
});
test('matching-only calls cannot publish cheap-model critiques', async () => {
  const raw = valid();
  raw.critiques = [{ type: 'logical_leap', severity: 'warning', description: 'A flaw', related_prop: 'P1', reasoning: 'Because.' }];
  callLLMWithFallback.mockResolvedValue({ output: raw });
  expect((await runSafeReasoner({ ...input, purpose: 'match' })).critiques).toEqual([]);
});
