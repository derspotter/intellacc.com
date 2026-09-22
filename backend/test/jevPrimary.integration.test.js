process.env.POST_SIGNAL_AGENTIC_MATCH_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_GATE_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_REASONER_ENABLED = 'true';
jest.mock('../src/services/openRouterMatcher/claimGate', () => ({ runSafeGate: jest.fn() }));
jest.mock('../src/services/openRouterMatcher/marketRetrieval', () => ({ retrieveCandidateMarkets: jest.fn() }));
jest.mock('../src/services/openRouterMatcher/argumentExtractor', () => ({ runSafeReasoner: jest.fn() }));
jest.mock('../src/services/ai/postCritiqueService', () => ({ review: jest.fn() }));
jest.mock('../src/services/metadata/metadataService', () => ({ extractFirstUrl: () => null }));
const { randomUUID } = require('crypto');
const db = require('../src/db');
const gate = require('../src/services/openRouterMatcher/claimGate');
const retrieval = require('../src/services/openRouterMatcher/marketRetrieval');
const reasoner = require('../src/services/openRouterMatcher/argumentExtractor');
const reviewer = require('../src/services/ai/postCritiqueService');
const pipeline = require('../src/services/openRouterMatcher/postMatchPipeline');
const nativeFetch = global.fetch;
jest.setTimeout(20000);
let userId, eventId, otherId, postId, selectedEvent, responseMode, beforeResponse;
const content = 'Rates will not fall by December.';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const critique = () => ({ best_market: { event_id: otherId, stance: 'agrees', confidence: 0.99, reasoning: 'LLM disagrees' },
  propositions: [], relations: [], conditional_flags: [],
  critiques: [{ critique_type: 'missing_base_rate', description: 'A test critique.', severity: 'info', related_prop: null }] });
const links = async () => (await db.query('SELECT event_id, stance, match_method, confirmed FROM post_market_links WHERE post_id=$1', [postId])).rows;
beforeAll(async () => {
  const id = randomUUID();
  userId = (await db.query('INSERT INTO users (username,email,password_hash) VALUES ($1,$2,$3) RETURNING id',
    [`primary_${id.slice(0, 8)}`, `${id}@example.com`, 'test-only'])).rows[0].id;
  await db.query("INSERT INTO user_ai_settings (user_id,provider,model,key_ciphertext) VALUES ($1,'openrouter','custom/any-model','test-stub')", [userId]);
  for (const title of ['Rates fall?', 'Other market?']) {
    const row = (await db.query("INSERT INTO events (title,closing_date,event_type) VALUES ($1,NOW()+INTERVAL '1 year','binary') RETURNING id", [title])).rows[0];
    if (!eventId) eventId = row.id; else otherId = row.id;
  }
});
beforeEach(async () => {
  await db.query("INSERT INTO user_post_critique_settings (user_id,model,enabled) VALUES ($1,'',TRUE) ON CONFLICT(user_id) DO UPDATE SET model='',enabled=TRUE", [userId]);
  process.env.POST_SIGNAL_JEV_MODE = 'primary'; process.env.OPENROUTER_API_KEY = 'test-only';
  postId = (await db.query('INSERT INTO posts (user_id,content) VALUES ($1,$2) RETURNING id', [userId, content])).rows[0].id;
  await db.query("UPDATE events SET hidden_at=NULL,closing_date=NOW()+INTERVAL '1 year' WHERE id=ANY($1::int[])", [[eventId, otherId]]);
  selectedEvent = eventId; responseMode = 'ok'; beforeResponse = null;
  retrieval.retrieveCandidateMarkets.mockReset().mockResolvedValue([{ event_id: eventId, title: 'Rates fall?', match_score: 0.9 }, { event_id: otherId, title: 'Other market?', match_score: 0.7 }]);
  gate.runSafeGate.mockReset().mockResolvedValue({ has_claim: true, claim_summary: content, entities: [] });
  reasoner.runSafeReasoner.mockReset().mockResolvedValue(critique());
  reviewer.review.mockReset().mockResolvedValue(critique());
  global.fetch = jest.fn(async (_url, options) => {
    if (beforeResponse) await beforeResponse();
    if (responseMode === 'error') throw new Error('secret-provider-error');
    if (responseMode === 'timeout') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const request = JSON.parse(options.body);
    const choice = responseMode === 'none' ? 'none' : `market_${selectedEvent}`;
    const answers = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === 'noul') answers[key] = { type: 'noul', noul: responseMode === 'none' ? 0.01 : key === 'has_claim' || key === `relevant_${selectedEvent}` ? 0.99 : 0.01 };
      else {
        const pick = key === 'best_market' ? choice : 'disagrees';
        answers[key] = { type: 'choice', choice: pick,
          confidence: responseMode === 'uncertain' ? 0.6 : 0.99,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === pick ? 1 : 0])) };
      }
    }
    if (responseMode === 'invalid') delete answers[`stance_${selectedEvent}`];
    return new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers, usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000042 } }));
  });
});
afterEach(async () => {
  global.fetch = nativeFetch; delete process.env.POST_SIGNAL_JEV_MODE; delete process.env.OPENROUTER_API_KEY;
  await db.query('DELETE FROM posts WHERE user_id=$1', [userId]);
});
afterAll(async () => { await db.query('DELETE FROM events WHERE id=ANY($1::int[])', [[eventId, otherId]]); await db.query('DELETE FROM users WHERE id=$1', [userId]); });

test('Jev link is visible before critique completes and critique cannot change it', async () => {
  const entered = deferred(); const release = deferred();
  reviewer.review.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return critique(); });
  const pending = pipeline.processPost(postId, content);
  try {
    await entered.promise;
    expect(await links()).toEqual([{ event_id: eventId, stance: 'disagrees', match_method: 'jev_v1', confirmed: false }]);
    expect(gate.runSafeGate).not.toHaveBeenCalled();
  } finally { release.resolve(); }
  expect(await pending).toMatchObject({ status: 'complete', reasoner_match: true });
  expect((await links())[0].event_id).toBe(eventId);
  expect((await db.query('SELECT description FROM post_critiques WHERE post_id=$1', [postId])).rows).toEqual([{ description: 'A test critique.' }]);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('critique failure preserves the accepted Jev link', async () => {
  reviewer.review.mockRejectedValue(new Error('Critique unavailable'));
  expect(await pipeline.processPost(postId, content)).toMatchObject({ reasoner_match: true });
  expect((await links())[0].event_id).toBe(eventId);
});
test('a failed critique database write does not erase or misreport the earlier link', async () => {
  const bad = critique(); bad.critiques[0].severity = 'invalid';
  reviewer.review.mockResolvedValue(bad);
  expect(await pipeline.processPost(postId, content)).toMatchObject({ reasoner_match: true });
  expect((await links())[0].event_id).toBe(eventId);
});
test('a critique about a different market cannot attach its conclusion to Jev\'s link', async () => {
  const analysis = critique();
  analysis.propositions = [{ label: 'P1', prop_type: 'conclusion', content: 'Another claim.', confidence_level: 'prediction' }];
  reviewer.review.mockResolvedValue(analysis);
  await pipeline.processPost(postId, content);
  const row = (await db.query('SELECT event_id,conclusion_prop_id FROM post_market_links WHERE post_id=$1', [postId])).rows[0];
  expect(row).toEqual({ event_id: eventId, conclusion_prop_id: null });
  expect((await db.query('SELECT id FROM propositions WHERE post_id=$1', [postId])).rows).toHaveLength(1);
});
test('confident no-claim makes no LLM calls and hides irrelevant candidates', async () => {
  responseMode = 'none';
  expect(await pipeline.processPost(postId, content)).toMatchObject({ status: 'gated_out', candidate_count: 0 });
  expect(gate.runSafeGate).not.toHaveBeenCalled(); expect(reasoner.runSafeReasoner).not.toHaveBeenCalled();
  expect(await links()).toEqual([]);
});
test.each(['error', 'timeout', 'invalid', 'uncertain'])('%s uses the LLM fallback once and retains diagnostics', async (mode) => {
  responseMode = mode;
  await pipeline.processPost(postId, content);
  expect(gate.runSafeGate).toHaveBeenCalledTimes(1); expect(reasoner.runSafeReasoner).toHaveBeenCalledTimes(1);
  expect(reasoner.runSafeReasoner.mock.calls[0][0].purpose).toBe('match');
  expect(reviewer.review).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect((await links())[0].event_id).toBe(otherId);
  const diagnostic = (await db.query('SELECT result FROM post_match_jev_shadow WHERE post_id=$1', [postId])).rows[0].result;
  expect(diagnostic.routing).toBe('llm_fallback'); expect(JSON.stringify(diagnostic)).not.toContain('secret-provider');
});
test('author-confirmed auto link survives primary matching and critique persistence', async () => {
  await db.query("INSERT INTO post_market_links (post_id,event_id,stance,source,confirmed) VALUES ($1,$2,'agrees','auto_match',TRUE)", [postId, otherId]);
  await pipeline.processPost(postId, content);
  expect(await links()).toEqual([{ event_id: otherId, stance: 'agrees', match_method: null, confirmed: true }]);
});
test('market hidden during inference cannot receive a new link', async () => {
  beforeResponse = () => db.query('UPDATE events SET hidden_at=NOW() WHERE id=$1', [eventId]);
  await pipeline.processPost(postId, content);
  expect(await links()).toEqual([]);
});
test('post hidden during inference cannot receive a Jev decision', async () => {
  beforeResponse = () => db.query('UPDATE posts SET is_hidden=TRUE WHERE id=$1', [postId]);
  expect(await pipeline.processPost(postId, content)).toMatchObject({ status: 'superseded' });
  expect(await links()).toEqual([]); expect(reasoner.runSafeReasoner).not.toHaveBeenCalled();
});
test('a delayed old critique cannot overwrite the match for a newer edit', async () => {
  const entered = deferred(); const release = deferred();
  reviewer.review.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return critique(); });
  const pending = pipeline.processPost(postId, content);
  try {
    await entered.promise;
    const edited = 'The other market will not happen.';
    await db.query('UPDATE posts SET content=$1 WHERE id=$2', [edited, postId]);
    selectedEvent = otherId;
    expect(await pipeline.processPost(postId, edited)).toMatchObject({ status: 'complete' });
  } finally { release.resolve(); }
  expect(await pending).toMatchObject({ status: 'superseded' });
  expect((await links())[0].event_id).toBe(otherId);
});

test('author model choice is used and its provenance is saved', async () => {
  await db.query('UPDATE user_post_critique_settings SET model=$2 WHERE user_id=$1', [userId, 'custom/any-model']);
  reviewer.review.mockResolvedValue({ ...critique(), critique_model: 'custom/any-model' });
  await pipeline.processPost(postId, content);
  expect(reviewer.review.mock.calls[0][0]).toMatchObject({ postId, content });
  expect((await db.query('SELECT model FROM post_critiques WHERE post_id=$1', [postId])).rows[0].model).toBe('custom/any-model');
});
test.each(['ok', 'uncertain'])('turning critiques off preserves matching (%s)', async (mode) => {
  responseMode = mode;
  await db.query('UPDATE user_post_critique_settings SET enabled=FALSE WHERE user_id=$1', [userId]);
  expect(await pipeline.processPost(postId, content)).toMatchObject({ reasoner_match: true });
  expect(reasoner.runSafeReasoner).toHaveBeenCalledTimes(mode === 'ok' ? 0 : 1);
  expect((await db.query('SELECT id FROM post_critiques WHERE post_id=$1', [postId])).rows).toHaveLength(0);
});
