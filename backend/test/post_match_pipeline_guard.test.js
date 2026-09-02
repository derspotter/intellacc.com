process.env.POST_SIGNAL_AGENTIC_MATCH_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_GATE_ENABLED = 'true';
process.env.POST_SIGNAL_MATCH_REASONER_ENABLED = 'true';

jest.mock('../src/services/openRouterMatcher/claimGate', () => ({
  runSafeGate: jest.fn()
}));

jest.mock('../src/services/openRouterMatcher/marketRetrieval', () => ({
  retrieveCandidateMarkets: jest.fn()
}));

jest.mock('../src/services/openRouterMatcher/argumentExtractor', () => ({
  runSafeReasoner: jest.fn()
}));

const db = require('../src/db');
const claimGate = require('../src/services/openRouterMatcher/claimGate');
const marketRetrieval = require('../src/services/openRouterMatcher/marketRetrieval');
const argumentExtractor = require('../src/services/openRouterMatcher/argumentExtractor');
const postMatchPipeline = require('../src/services/openRouterMatcher/postMatchPipeline');

jest.setTimeout(30000);

const makeUser = async (label) => {
  const unique = `${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const result = await db.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, 'x')
     RETURNING id`,
    [unique, `${unique}@example.com`]
  );
  return result.rows[0].id;
};

const makePost = async (userId) => {
  const result = await db.query(
    `INSERT INTO posts (user_id, content)
     VALUES ($1, $2)
     RETURNING id, content`,
    [userId, `Pipeline guard post ${Date.now()}_${Math.floor(Math.random() * 10000)}`]
  );
  return result.rows[0];
};

const makeEvent = async () => {
  const closingDate = new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString();
  const result = await db.query(
    `INSERT INTO events (title, details, closing_date, event_type, category)
     VALUES ($1, 'guard', $2, 'binary', 'test')
     RETURNING id, title`,
    [`Guard event ${Date.now()}_${Math.floor(Math.random() * 10000)}`, closingDate]
  );
  return result.rows[0];
};

const attachManualLink = async (postId, eventId) => {
  await db.query(
    `INSERT INTO post_market_links (post_id, event_id, stance, source, confirmed, match_method)
     VALUES ($1, $2, 'agrees', 'author_confirmed', TRUE, 'manual')`,
    [postId, eventId]
  );
};

const candidateFor = (event) => ({
  event_id: event.id,
  title: event.title,
  closing_date: null,
  match_score: 0.9,
  vec_score: 0.8,
  text_score: 0.7
});

const reasonerResultFor = (event) => ({
  best_market: { event_id: event.id, stance: 'agrees', confidence: 0.9 },
  propositions: [],
  critiques: [],
  conditional_flags: []
});

describe('postMatchPipeline manual link guard', () => {
  const cleanup = { users: new Set(), posts: new Set(), events: new Set() };

  beforeEach(() => {
    claimGate.runSafeGate.mockReset();
    marketRetrieval.retrieveCandidateMarkets.mockReset();
    argumentExtractor.runSafeReasoner.mockReset();

    claimGate.runSafeGate.mockResolvedValue({
      has_claim: true,
      domain: null,
      claim_summary: 'guard claim',
      entities: []
    });
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

  test('reasoner picking the manually linked event does not clobber the manual link', async () => {
    const userId = await makeUser('guard_same');
    cleanup.users.add(userId);
    const event = await makeEvent();
    cleanup.events.add(event.id);
    const post = await makePost(userId);
    cleanup.posts.add(post.id);

    await attachManualLink(post.id, event.id);

    marketRetrieval.retrieveCandidateMarkets.mockResolvedValue([candidateFor(event)]);
    argumentExtractor.runSafeReasoner.mockResolvedValue(reasonerResultFor(event));

    await postMatchPipeline.processPost(post.id, post.content);

    const link = await db.query(
      'SELECT source, confirmed, match_method, stance FROM post_market_links WHERE post_id = $1 AND event_id = $2',
      [post.id, event.id]
    );
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0]).toMatchObject({
      source: 'author_confirmed',
      confirmed: true,
      match_method: 'manual',
      stance: 'agrees'
    });
  });

  test('pipeline does not add a competing auto link when a confirmed link exists', async () => {
    const userId = await makeUser('guard_other');
    cleanup.users.add(userId);
    const manualEvent = await makeEvent();
    const autoEvent = await makeEvent();
    cleanup.events.add(manualEvent.id);
    cleanup.events.add(autoEvent.id);
    const post = await makePost(userId);
    cleanup.posts.add(post.id);

    await attachManualLink(post.id, manualEvent.id);

    marketRetrieval.retrieveCandidateMarkets.mockResolvedValue([candidateFor(autoEvent)]);
    argumentExtractor.runSafeReasoner.mockResolvedValue(reasonerResultFor(autoEvent));

    await postMatchPipeline.processPost(post.id, post.content);

    const autoLinks = await db.query(
      `SELECT 1 FROM post_market_links WHERE post_id = $1 AND source = 'auto_match'`,
      [post.id]
    );
    expect(autoLinks.rows).toHaveLength(0);

    const manualLink = await db.query(
      'SELECT source, confirmed FROM post_market_links WHERE post_id = $1 AND event_id = $2',
      [post.id, manualEvent.id]
    );
    expect(manualLink.rows[0]).toMatchObject({ source: 'author_confirmed', confirmed: true });
  });

  test('pipeline still links normally when no confirmed link exists', async () => {
    const userId = await makeUser('guard_none');
    cleanup.users.add(userId);
    const event = await makeEvent();
    cleanup.events.add(event.id);
    const post = await makePost(userId);
    cleanup.posts.add(post.id);

    marketRetrieval.retrieveCandidateMarkets.mockResolvedValue([candidateFor(event)]);
    argumentExtractor.runSafeReasoner.mockResolvedValue(reasonerResultFor(event));

    await postMatchPipeline.processPost(post.id, post.content);

    const link = await db.query(
      'SELECT source, confirmed FROM post_market_links WHERE post_id = $1 AND event_id = $2',
      [post.id, event.id]
    );
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0]).toMatchObject({ source: 'auto_match', confirmed: false });
  });
});
