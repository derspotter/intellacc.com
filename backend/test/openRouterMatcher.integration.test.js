process.env.POST_SIGNAL_AGENTIC_MATCH_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_GATE_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_REASONER_ENABLED = 'false';

jest.mock('../src/services/openRouterMatcher/claimGate', () => ({
  runSafeGate: jest.fn()
}));

jest.mock('../src/services/openRouterMatcher/marketRetrieval', () => ({
  retrieveCandidateMarkets: jest.fn()
}));

jest.mock('../src/services/openRouterMatcher/argumentExtractor', () => ({
  runSafeReasoner: jest.fn().mockResolvedValue(null)
}));

const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const claimGate = require('../src/services/openRouterMatcher/claimGate');
const marketRetrieval = require('../src/services/openRouterMatcher/marketRetrieval');

jest.setTimeout(30000);

const ensureMatchingSchema = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS post_market_matches (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      match_score DECIMAL(10, 6) NOT NULL DEFAULT 0.0,
      match_method VARCHAR(20) NOT NULL DEFAULT 'hybrid_v1',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      CONSTRAINT unique_post_market_match UNIQUE (post_id, event_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS post_analysis (
      post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      has_claim BOOLEAN NOT NULL DEFAULT FALSE,
      domain VARCHAR(50),
      claim_summary TEXT,
      entities TEXT[],
      processing_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      gate_model VARCHAR(100),
      reason_model VARCHAR(100),
      gate_latency_ms INTEGER,
      reason_latency_ms INTEGER,
      processing_errors TEXT,
      candidates_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE post_analysis
      DROP CONSTRAINT IF EXISTS post_analysis_processing_status_check
  `);

  await db.query(`
    ALTER TABLE post_analysis
      ADD CONSTRAINT post_analysis_processing_status_check
      CHECK (
        processing_status IN (
          'not_started',
          'pending',
          'retrieving',
          'reasoning',
          'complete',
          'gated_out',
          'failed'
        )
      )
  `);
};

const makeUser = async (label, verificationTier = 1) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const email = `${unique}@example.com`;
  const username = unique;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  expect(loginRes.statusCode).toBe(200);

  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = userResult.rows[0].id;

  if (verificationTier != null) {
    await db.query('UPDATE users SET verification_tier = $1 WHERE id = $2', [verificationTier, userId]);
  }

  return {
    id: userId,
    token: loginRes.body.token
  };
};

const createEvent = async () => {
  const closingDate = new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString();
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type, category)
     VALUES ($1, $2, $3, 'binary', 'test')
     RETURNING id`,
    [`Matcher event ${Date.now()}_${Math.floor(Math.random() * 10000)}`, 'Will this match?', closingDate]
  );
  return result.rows[0].id;
};

const waitForPipeline = async (postId, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await db.query(
      'SELECT processing_status FROM post_analysis WHERE post_id = $1',
      [postId]
    );
    if (result.rows.length > 0 && result.rows[0].processing_status === 'complete') {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
};

describe('OpenRouter matcher integration', () => {
  const cleanup = {
    users: new Set(),
    posts: new Set(),
    events: new Set()
  };

  beforeAll(async () => {
    await ensureMatchingSchema();
  });

  beforeEach(() => {
    claimGate.runSafeGate.mockReset();
    marketRetrieval.retrieveCandidateMarkets.mockReset();
  });

  afterAll(async () => {
    if (cleanup.posts.size) {
      await db.query('DELETE FROM posts WHERE id = ANY($1::int[])', [Array.from(cleanup.posts)]);
    }

    if (cleanup.events.size) {
      await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [Array.from(cleanup.events)]);
    }

    for (const userId of cleanup.users) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('create post triggers async pipeline and persists market proposals', async () => {
    const author = await makeUser('matcher_author');
    cleanup.users.add(author.id);

    const eventId = await createEvent();
    cleanup.events.add(eventId);

    claimGate.runSafeGate.mockResolvedValue({
      has_claim: true,
      domain: 'economics',
      claim_summary: 'The Federal Reserve will cut rates',
      entities: ['Federal Reserve', 'rates']
    });

    marketRetrieval.retrieveCandidateMarkets.mockResolvedValue([
      {
        event_id: eventId,
        title: 'Will the Fed cut rates?',
        match_score: 0.91,
        match_method: 'hybrid_v1'
      }
    ]);

    const postRes = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${author.token}`)
      .send({ content: 'Fed cut likely this year.' });

    expect(postRes.statusCode).toBe(201);
    const postId = postRes.body.id;
    cleanup.posts.add(postId);

    const completed = await waitForPipeline(postId);
    expect(completed).toBe(true);

    const analysis = await db.query(
      `SELECT has_claim, processing_status, claim_summary, candidates_count
         FROM post_analysis
        WHERE post_id = $1`,
      [postId]
    );
    expect(analysis.rows.length).toBe(1);
    expect(analysis.rows[0].has_claim).toBe(true);
    expect(analysis.rows[0].processing_status).toBe('complete');
    expect(Number(analysis.rows[0].candidates_count)).toBe(1);

    const matches = await db.query(
      `SELECT event_id, match_method, match_score
         FROM post_market_matches
        WHERE post_id = $1`,
      [postId]
    );
    expect(matches.rows.length).toBe(1);
    expect(Number(matches.rows[0].event_id)).toBe(eventId);
    expect(matches.rows[0].match_method).toBe('hybrid_v1');
    expect(Number(matches.rows[0].match_score)).toBeGreaterThan(0);
  });
});
