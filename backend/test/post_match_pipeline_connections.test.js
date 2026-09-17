// Integration regressions: a real PostgreSQL pool with ONE connection, with
// all external services mocked. Run only against the isolated test database.
process.env.POST_SIGNAL_AGENTIC_MATCH_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_GATE_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_REASONER_ENABLED = 'true';

jest.mock('../src/services/openRouterMatcher/claimGate', () => ({ runSafeGate: jest.fn() }));
jest.mock('../src/services/openRouterMatcher/marketRetrieval', () => ({ retrieveCandidateMarkets: jest.fn() }));
jest.mock('../src/services/openRouterMatcher/argumentExtractor', () => ({ runSafeReasoner: jest.fn() }));
jest.mock('../src/services/metadata/metadataService', () => ({
  extractFirstUrl: (text) => text.includes('https://') ? 'https://example.test/article' : null,
  fetchArticleContent: jest.fn()
}));

const { randomUUID } = require('crypto');
const db = require('../src/db');
const gate = require('../src/services/openRouterMatcher/claimGate');
const retrieval = require('../src/services/openRouterMatcher/marketRetrieval');
const reasoner = require('../src/services/openRouterMatcher/argumentExtractor');
const metadata = require('../src/services/metadata/metadataService');
const pipeline = require('../src/services/openRouterMatcher/postMatchPipeline');

jest.setTimeout(15000);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const waitFor = async (check) => {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Pipeline did not reach the external call');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('matching releases connections during external work', () => {
  let userId;
  let eventId;
  let pool;
  let originalMax;
  const posts = [];
  const gateResult = { has_claim: true, claim_summary: 'Test prediction', domain: null, entities: [] };
  const candidates = () => [{ event_id: eventId, title: 'Test market', match_score: 0.9 }];
  const argument = () => ({
    propositions: [], conditional_flags: [], critiques: [],
    best_market: { event_id: eventId, stance: 'agrees', confidence: 0.9 }
  });
  const makePost = async (content = 'An isolated performance claim') => {
    const row = (await db.query('INSERT INTO posts (user_id, content) VALUES ($1, $2) RETURNING id, content', [userId, content])).rows[0];
    posts.push(row.id);
    return row;
  };
  const status = async (id) => (await db.query('SELECT processing_status, processing_errors FROM post_analysis WHERE post_id = $1', [id])).rows[0];
  const expectPoolFree = () => {
    expect(pool.totalCount - pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  };

  beforeAll(async () => {
    pool = db.getPool();
    originalMax = pool.options.max;
    pool.options.max = 1;
    // Bound a broken implementation's nested acquisition instead of hanging CI.
    pool.options.connectionTimeoutMillis = 3000;
    const name = `perf_${randomUUID().slice(0, 8)}`;
    userId = (await db.query("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'test') RETURNING id", [name, `${name}@example.test`])).rows[0].id;
    eventId = (await db.query("INSERT INTO events (title, closing_date, event_type) VALUES ('Performance test', NOW() + INTERVAL '1 day', 'binary') RETURNING id")).rows[0].id;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    gate.runSafeGate.mockReset().mockResolvedValue(gateResult);
    retrieval.retrieveCandidateMarkets.mockReset().mockImplementation(async () => {
      // The real retriever also uses db.query while the pipeline is running.
      await db.query('SELECT 1');
      return candidates();
    });
    reasoner.runSafeReasoner.mockReset().mockImplementation(async () => argument());
    metadata.fetchArticleContent.mockReset().mockResolvedValue('Article content long enough to augment a claim for this test.');
  });

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    await db.query('DELETE FROM posts WHERE id = ANY($1::int[])', [posts]);
    await db.query('DELETE FROM events WHERE id = $1', [eventId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    pool.options.max = originalMax;
  });

  test.each([
    ['article', 'pending'], ['gate', 'retrieving'],
    ['retrieval', 'retrieving'], ['reasoner', 'reasoning']
  ])('%s wait retains no connection and exposes %s status', async (stage, expectedStatus) => {
    const post = await makePost(stage === 'article' ? 'Claim at https://example.test/article' : undefined);
    const pause = deferred();
    let entered = false;
    const mock = { article: metadata.fetchArticleContent, gate: gate.runSafeGate,
      retrieval: retrieval.retrieveCandidateMarkets, reasoner: reasoner.runSafeReasoner }[stage];
    const value = { article: 'Enough article text to augment this isolated test prediction.',
      gate: gateResult, retrieval: candidates(), reasoner: argument() }[stage];
    mock.mockImplementationOnce(async () => { entered = true; await pause.promise; return value; });
    const running = pipeline.processPost(post.id, post.content);
    try {
      await waitFor(() => entered);
      expectPoolFree();
      expect((await status(post.id)).processing_status).toBe(expectedStatus);
      expect((await db.query('SELECT 42 AS answer')).rows[0].answer).toBe(42);
    } finally { pause.resolve(); }
    expect((await running).status).toBe('complete');
    expectPoolFree();
  });

  test('eight simultaneous jobs finish with a one-connection pool and nested retrieval queries', async () => {
    const fixtures = [];
    for (let i = 0; i < 8; i += 1) fixtures.push(await makePost());
    const pause = deferred();
    let entered = 0;
    gate.runSafeGate.mockImplementation(async () => { entered += 1; await pause.promise; return gateResult; });
    const running = Promise.all(fixtures.map((post) => pipeline.processPost(post.id, post.content)));
    try {
      await waitFor(() => entered === fixtures.length);
      expectPoolFree();
      await db.query('SELECT 1');
    } finally { pause.resolve(); }
    expect((await running).map((result) => result.status)).toEqual(Array(8).fill('complete'));
    expectPoolFree();
  });

  test('a later job wins even when an earlier reasoner completes last', async () => {
    const post = await makePost();
    const pause = deferred();
    let entered = false;
    reasoner.runSafeReasoner.mockImplementationOnce(async () => { entered = true; await pause.promise; return argument(); });
    const older = pipeline.processPost(post.id, post.content);
    try {
      await waitFor(() => entered);
      gate.runSafeGate.mockResolvedValueOnce({ has_claim: false });
      expect((await pipeline.processPost(post.id, post.content)).status).toBe('gated_out');
    } finally { pause.resolve(); }
    expect((await older).status).toBe('superseded');
    expect((await status(post.id)).processing_status).toBe('gated_out');
    expect((await db.query('SELECT * FROM post_market_matches WHERE post_id = $1', [post.id])).rows).toEqual([]);
  });

  test('a post edit fences out old results even before the replacement job starts', async () => {
    const post = await makePost();
    const pause = deferred();
    let entered = false;
    reasoner.runSafeReasoner.mockImplementationOnce(async () => { entered = true; await pause.promise; return argument(); });
    const older = pipeline.processPost(post.id, post.content);
    try {
      await waitFor(() => entered);
      await db.query('UPDATE posts SET content = $2 WHERE id = $1', [post.id, 'Edited claim']);
    } finally { pause.resolve(); }
    expect((await older).status).toBe('superseded');
    expect((await db.query('SELECT * FROM post_market_matches WHERE post_id = $1', [post.id])).rows).toEqual([]);
    expect((await pipeline.processPost(post.id, post.content)).status).toBe('superseded');
    expect((await pipeline.processPost(post.id, 'Edited claim')).status).toBe('complete');
  });

  test('a stale retrieval failure cannot mark a newer run failed', async () => {
    const post = await makePost();
    const pause = deferred();
    let entered = false;
    retrieval.retrieveCandidateMarkets.mockImplementationOnce(async () => {
      entered = true; await pause.promise; throw new Error('Old retrieval failed');
    });
    const older = pipeline.processPost(post.id, post.content).catch((error) => error);
    try {
      await waitFor(() => entered);
      gate.runSafeGate.mockResolvedValueOnce({ has_claim: false });
      await pipeline.processPost(post.id, post.content);
    } finally { pause.resolve(); }
    expect((await older).message).toBe('Old retrieval failed');
    expect((await status(post.id)).processing_status).toBe('gated_out');
    expectPoolFree();
  });

  test('final persistence failure rolls back candidates and releases the connection before failure logging', async () => {
    const post = await makePost();
    const acquire = pool.connect.bind(pool);
    // pool.query uses callback-style connect. Inject only the final transaction
    // via the facade instead of intercepting the driver's internal acquisitions.
    const finalPool = { connect: async () => {
      const client = await acquire();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      client.query = (sql, params) => String(sql).includes('INSERT INTO post_market_matches')
        ? Promise.reject(new Error('Simulated final write failure')) : query(sql, params);
      client.release = (...args) => { client.query = query; return release(...args); };
      return client;
    } };
    jest.spyOn(db, 'getPool').mockReturnValue(finalPool);
    await expect(pipeline.processPost(post.id, post.content)).rejects.toThrow('Simulated final write failure');
    expect((await status(post.id)).processing_status).toBe('failed');
    expect((await db.query('SELECT * FROM post_market_matches WHERE post_id = $1', [post.id])).rows).toEqual([]);
    expectPoolFree();
  });
});
