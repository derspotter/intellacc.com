process.env.POST_SIGNAL_AGENTIC_MATCH_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_GATE_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_REASONER_ENABLED = 'true';

jest.mock('../src/services/openRouterMatcher/claimGate', () => ({ runSafeGate: jest.fn() }));
jest.mock('../src/services/openRouterMatcher/marketRetrieval', () => ({ retrieveCandidateMarkets: jest.fn() }));
jest.mock('../src/services/openRouterMatcher/argumentExtractor', () => ({ runSafeReasoner: jest.fn() }));
jest.mock('../src/services/metadata/metadataService', () => ({ extractFirstUrl: () => null }));

const { randomUUID } = require('crypto');
const { readFileSync } = require('fs');
const { join } = require('path');
const db = require('../src/db');
const gate = require('../src/services/openRouterMatcher/claimGate');
const retrieval = require('../src/services/openRouterMatcher/marketRetrieval');
const reasoner = require('../src/services/openRouterMatcher/argumentExtractor');
const jev = require('../src/services/openRouterMatcher/jevShadow');
const pipeline = require('../src/services/openRouterMatcher/postMatchPipeline');

let userId;
let eventId;
let postId;
let nativeFetch;
const content = 'Rates will fall by December.';
const makeResponse = () => new Response(JSON.stringify({
  model: 'typesafe/jev-1.13',
  answers: {
    has_claim: { type: 'noul', noul: 0.8 },
    best_market: { type: 'choice', choice: 'none', confidence: 0.5, probabilities: { none: 0.8, [`market_${eventId}`]: 0.2 } },
    [`relevant_${eventId}`]: { type: 'noul', noul: 0.2 }
  },
  usage: { input_tokens: 100, output_tokens: 30 }
}));
const diagnostic = async () => (await db.query('SELECT * FROM post_match_jev_shadow WHERE post_id = $1', [postId])).rows[0];

beforeAll(async () => {
  const unique = randomUUID();
  userId = (await db.query('INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [`jev_${unique.slice(0, 8)}`, `${unique}@example.com`, 'test-only'])).rows[0].id;
  eventId = (await db.query("INSERT INTO events (title, details, closing_date, event_type) VALUES ('Rates fall?', 'Test criteria', NOW() + interval '1 year', 'binary') RETURNING id")).rows[0].id;
  nativeFetch = global.fetch;
});
beforeEach(async () => {
  process.env.POST_SIGNAL_JEV_MODE = 'shadow';
  process.env.OPENROUTER_API_KEY = 'test-only';
  postId = (await db.query('INSERT INTO posts (user_id, content) VALUES ($1, $2) RETURNING id', [userId, content])).rows[0].id;
  gate.runSafeGate.mockReset().mockResolvedValue({ has_claim: true, claim_summary: content, domain: 'finance', entities: [] });
  retrieval.retrieveCandidateMarkets.mockReset().mockResolvedValue([{ event_id: eventId, title: 'Rates fall?', details: 'Test criteria', match_score: 0.9 }]);
  reasoner.runSafeReasoner.mockReset().mockResolvedValue({
    best_market: { event_id: eventId, stance: 'agrees', confidence: 0.9, reasoning: 'Test' },
    propositions: [], relations: [], conditional_flags: [], critiques: []
  });
  global.fetch = jest.fn().mockImplementation(async () => makeResponse());
});
afterEach(async () => {
  global.fetch = nativeFetch;
  delete process.env.POST_SIGNAL_JEV_MODE;
  delete process.env.OPENROUTER_API_KEY;
  await db.query('DELETE FROM posts WHERE user_id = $1', [userId]);
});
afterAll(async () => {
  await db.query('DELETE FROM events WHERE id = $1', [eventId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
});

test('Jev disagreement is recorded without changing the baseline link', async () => {
  const result = await pipeline.processPost(postId, content);
  expect(result).toMatchObject({ status: 'complete', reasoner_match: true });
  expect((await db.query('SELECT event_id FROM post_market_links WHERE post_id = $1', [postId])).rows).toEqual([{ event_id: eventId }]);
  const row = await diagnostic();
  expect(row.status).toBe('ok');
  expect(row.result.answers.best_market.choice).toBe('none');
  expect(row.baseline).toMatchObject({ proposed_event_id: eventId, persisted_match: true });
});

test('negative gate is observed without triggering candidate retrieval or reasoner', async () => {
  gate.runSafeGate.mockResolvedValue({ has_claim: false });
  const result = await pipeline.processPost(postId, content);
  expect(result.status).toBe('gated_out');
  expect(retrieval.retrieveCandidateMarkets).not.toHaveBeenCalled();
  expect(reasoner.runSafeReasoner).not.toHaveBeenCalled();
  expect((await diagnostic()).result.answers.has_claim.noul).toBe(0.8);
});

test('provider failure preserves successful baseline and records redacted error', async () => {
  global.fetch.mockRejectedValue(new Error('provider secret'));
  expect(await pipeline.processPost(postId, content)).toMatchObject({ status: 'complete', reasoner_match: true });
  expect((await diagnostic()).result).toMatchObject({ status: 'error', error_code: 'provider_error' });
});

test('off mode creates no diagnostic or provider request', async () => {
  process.env.POST_SIGNAL_JEV_MODE = 'off';
  expect(await pipeline.processPost(postId, content)).toMatchObject({ status: 'complete', reasoner_match: true });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(await diagnostic()).toBeUndefined();
});

test('non-top-level post is excluded using actual database eligibility', async () => {
  const parentId = (await db.query('INSERT INTO posts (user_id, content) VALUES ($1, $2) RETURNING id', [userId, 'parent'])).rows[0].id;
  await db.query('UPDATE posts SET parent_id = $1 WHERE id = $2', [parentId, postId]);
  await pipeline.processPost(postId, content);
  expect(global.fetch).not.toHaveBeenCalled();
  expect((await diagnostic()).result.error_code).toBe('ineligible_post');
});

test('hidden posts and community posts are excluded before API calls', async () => {
  await db.query('UPDATE posts SET is_hidden = TRUE WHERE id = $1', [postId]);
  await pipeline.processPost(postId, content);
  expect(global.fetch).not.toHaveBeenCalled();
  const topicId = (await db.query('INSERT INTO topics (name) VALUES ($1) RETURNING id', [`jev_${randomUUID()}`])).rows[0].id;
  try {
    const groupId = (await db.query('INSERT INTO community_groups (slug, name, topic_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [`jev-${randomUUID()}`, 'Jev test', topicId, userId])).rows[0].id;
    await db.query('UPDATE posts SET is_hidden = FALSE, community_group_id = $1 WHERE id = $2', [groupId, postId]);
    await pipeline.processPost(postId, content);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await diagnostic()).result.error_code).toBe('ineligible_post');
  } finally {
    await db.query('DELETE FROM community_groups WHERE topic_id = $1', [topicId]);
    await db.query('DELETE FROM topics WHERE id = $1', [topicId]);
  }
});

test('read-only report returns observations and excludes changed post content', async () => {
  await pipeline.processPost(postId, content);
  const sql = readFileSync(join(__dirname, '../scripts/jev-shadow-report.sql'), 'utf8');
  const report = await db.query(sql);
  expect(report[1].rows).toContainEqual(expect.objectContaining({ status: 'ok', posts: '1' }));
  expect(report[3].rows).toContainEqual(expect.objectContaining({ post_id: postId, jev_choice: 'none' }));
  await db.query('UPDATE posts SET content = $1 WHERE id = $2', ['Edited without a new run yet.', postId]);
  const afterEdit = await db.query(sql);
  expect(afterEdit[1].rows).toHaveLength(0);
});

test('late old response cannot replace an edited post observation', async () => {
  let release;
  let started;
  const barrier = new Promise((resolve) => { started = resolve; });
  global.fetch.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve(makeResponse()); started();
  }));
  const oldRun = pipeline.processPost(postId, content);
  await barrier;
  const edited = 'Rates will rise by December.';
  await db.query('UPDATE posts SET content = $1 WHERE id = $2', [edited, postId]);
  expect((await pipeline.processPost(postId, edited)).status).toBe('complete');
  const current = await diagnostic();
  release();
  expect((await oldRun).status).toBe('superseded');
  expect((await diagnostic()).processing_run_id).toBe(current.processing_run_id);
});

test('deletion while provider call is in flight leaves no diagnostic behind', async () => {
  let release;
  let started;
  const barrier = new Promise((resolve) => { started = resolve; });
  global.fetch.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve(makeResponse()); started();
  }));
  const pending = pipeline.processPost(postId, content);
  await barrier;
  await db.query('DELETE FROM posts WHERE id = $1', [postId]);
  release();
  expect((await pending).status).toBe('superseded');
  expect(await diagnostic()).toBeUndefined();
});

test('post deletion cascades a saved observation', async () => {
  await pipeline.processPost(postId, content);
  expect(await diagnostic()).toBeDefined();
  await db.query('DELETE FROM posts WHERE id = $1', [postId]);
  expect(await diagnostic()).toBeUndefined();
});

test('a failed diagnostic insert leaves the enclosing PostgreSQL transaction usable', async () => {
  const client = await db.getPool().connect();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE post_match_jev_shadow (post_id INT) ON COMMIT DROP');
    await jev.persist(client, { postId, run: { id: randomUUID() }, result: { content_hash: 'test', status: 'ok' }, baseline: {} });
    expect((await client.query('SELECT 42 AS answer')).rows[0].answer).toBe(42);
    await client.query('COMMIT');
    expect(warn).toHaveBeenCalledWith('[JevShadow] Diagnostic write failed');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    warn.mockRestore();
  }
});
