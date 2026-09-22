jest.mock('../src/services/openRouterMatcher/config', () => ({
  openRouterApiKey: 'test-key', openRouterBaseUrl: 'https://example.invalid'
}));
const { callLLMWithFallback } = require('../src/services/openRouterMatcher/llmClient');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('fallback keeps the schema but applies only its own model parameters', async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '{}' })
    .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({
      model: 'deepseek/deepseek-v4.1-flash', choices: [{ message: { content: '{"ok":true}' } }]
    }) });
  const schema = { type: 'json_schema', json_schema: { name: 'test' } };
  const result = await callLLMWithFallback({
    messages: [], timeoutMs: 1000,
    extraParams: { response_format: schema, reasoning: { enabled: true, max_tokens: 256 } },
    extraParamsByModel: { 'deepseek/deepseek-v4.1-flash': { reasoning: { effort: 'low' } } }
  }, { primaryModel: 'openai/gpt-5.6-luna', fallbackModels: ['deepseek/deepseek-v4.1-flash'] });
  expect(result.output).toEqual({ ok: true });
  const bodies = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
  expect(bodies[0]).toMatchObject({ model: 'openai/gpt-5.6-luna', reasoning: { enabled: true, max_tokens: 256 } });
  expect(bodies[1]).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash', response_format: schema });
  expect(bodies[1].reasoning).toEqual({ effort: 'low' });
  expect(bodies[1].extraParamsByModel).toBeUndefined();
});
