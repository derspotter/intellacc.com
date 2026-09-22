const names = ['POST_SIGNAL_MATCH_REASONER_MODEL', 'POST_SIGNAL_MATCH_REASONER_HEAVY_MODEL',
  'POST_SIGNAL_MATCH_REASONER_FALLBACK_MODELS', 'POST_SIGNAL_MATCH_REASONER_HEAVY_FALLBACK_MODELS'];
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
beforeEach(() => { names.forEach((name) => delete process.env[name]); jest.resetModules(); });
afterAll(() => { names.forEach((name) => {
  if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
}); });
const read = () => require('../src/services/openRouterMatcher/config').reasoner;
test('short and long posts share the inexpensive default and fallback', () => {
  expect(read()).toMatchObject({ model: 'openai/gpt-6-luna', heavyModel: 'openai/gpt-6-luna',
    fallbackModels: ['deepseek/deepseek-v4.1-flash'], heavyFallbackModels: ['deepseek/deepseek-v4.1-flash'] });
});
test('explicit primary and fallback overrides also govern long posts by default', () => {
  process.env.POST_SIGNAL_MATCH_REASONER_MODEL = 'custom/model';
  process.env.POST_SIGNAL_MATCH_REASONER_FALLBACK_MODELS = 'custom/fallback';
  expect(read()).toMatchObject({ heavyModel: 'custom/model', heavyFallbackModels: ['custom/fallback'] });
});
test('explicit heavy-model configuration is preserved', () => {
  process.env.POST_SIGNAL_MATCH_REASONER_HEAVY_MODEL = 'custom/heavy';
  process.env.POST_SIGNAL_MATCH_REASONER_HEAVY_FALLBACK_MODELS = 'custom/heavy-fallback';
  expect(read()).toMatchObject({ heavyModel: 'custom/heavy', heavyFallbackModels: ['custom/heavy-fallback'] });
});
