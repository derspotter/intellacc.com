const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(60000);

// The home feed is no longer follow-only: it blends posts from people you
// follow, posts tied to markets in your topics, and posts by users who share
// your topics. When those sources are thin the feed falls through to everyone
// so a new account never sees a blank page.

const createUser = async (label) => {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const login = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  return { id: row.rows[0].id, username, token: login.body.token };
};

const insertPost = async (userId, content) => {
  const res = await db.query('INSERT INTO posts (user_id, content) VALUES ($1, $2) RETURNING id', [userId, content]);
  return res.rows[0].id;
};

const setTopics = async (userId, topicIds) => {
  await db.query('DELETE FROM user_topics WHERE user_id = $1', [userId]);
  for (const topicId of topicIds) {
    await db.query('INSERT INTO user_topics (user_id, topic_id) VALUES ($1, $2)', [userId, topicId]);
  }
};

const fetchFeed = async (token, query = '') => {
  const res = await request(app).get(`/api/feed${query}`).set('Authorization', `Bearer ${token}`);
  expect(res.statusCode).toBe(200);
  return res.body;
};

const sourceOf = (body, postId) => {
  const row = (body.items || []).find((item) => item.id === postId);
  return row ? row.feed_source : null;
};

describe('Blended home feed sources', () => {
  const cleanup = { userIds: [], postIds: [], eventIds: [], topicIds: [] };
  let viewer, followee, marketAuthor, topicPeer, stranger;
  let myTopicId, otherTopicId, eventId;
  let followedPostId, marketPostId, topicPeerPostId, strangerPostId;

  beforeAll(async () => {
    viewer = await createUser('blendviewer');
    followee = await createUser('blendfollowee');
    marketAuthor = await createUser('blendmarket');
    topicPeer = await createUser('blendpeer');
    stranger = await createUser('blendstranger');
    cleanup.userIds.push(viewer.id, followee.id, marketAuthor.id, topicPeer.id, stranger.id);

    const mk = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing)
       VALUES ('BlendMine' || floor(random()*1e9), 'blend-mine-' || floor(random()*1e9), TRUE) RETURNING id`
    );
    myTopicId = mk.rows[0].id;
    const other = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing)
       VALUES ('BlendOther' || floor(random()*1e9), 'blend-other-' || floor(random()*1e9), TRUE) RETURNING id`
    );
    otherTopicId = other.rows[0].id;
    cleanup.topicIds.push(myTopicId, otherTopicId);

    await setTopics(viewer.id, [myTopicId]);
    await setTopics(topicPeer.id, [myTopicId]);
    await setTopics(marketAuthor.id, [otherTopicId]);
    await setTopics(stranger.id, [otherTopicId]);
    await setTopics(followee.id, [otherTopicId]);

    const ev = await db.query(
      `INSERT INTO events (title, closing_date, market_prob)
       VALUES ('Blend feed market', NOW() + INTERVAL '30 days', 0.5) RETURNING id`
    );
    eventId = ev.rows[0].id;
    cleanup.eventIds.push(eventId);
    await db.query(`INSERT INTO event_topics (event_id, topic_id, source) VALUES ($1, $2, 'test')`, [eventId, myTopicId]);

    await request(app).post(`/api/users/${followee.id}/follow`).set('Authorization', `Bearer ${viewer.token}`);

    followedPostId = await insertPost(followee.id, 'post from someone I follow');
    marketPostId = await insertPost(marketAuthor.id, 'post tied to a market in my topics');
    topicPeerPostId = await insertPost(topicPeer.id, 'post by a user who shares my topics');
    strangerPostId = await insertPost(stranger.id, 'post by an unrelated stranger');
    cleanup.postIds.push(followedPostId, marketPostId, topicPeerPostId, strangerPostId);

    await db.query(
      `INSERT INTO post_market_links (post_id, event_id, stance, source, confirmed)
       VALUES ($1, $2, 'related', 'author_confirmed', TRUE)`,
      [marketPostId, eventId]
    );
  });

  afterAll(async () => {
    if (cleanup.postIds.length) await db.query('DELETE FROM posts WHERE id = ANY($1::int[])', [cleanup.postIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('a post from someone I follow is labelled following', async () => {
    const body = await fetchFeed(viewer.token);
    expect(sourceOf(body, followedPostId)).toBe('following');
  });

  test('a stranger post tied to a market in my topics is labelled topic_market', async () => {
    const body = await fetchFeed(viewer.token);
    expect(sourceOf(body, marketPostId)).toBe('topic_market');
  });

  test('a post by a user who shares my topics is labelled topic_user', async () => {
    const body = await fetchFeed(viewer.token);
    expect(sourceOf(body, topicPeerPostId)).toBe('topic_user');
  });

  test('an unrelated post only appears through the global fall-through', async () => {
    const body = await fetchFeed(viewer.token);
    const source = sourceOf(body, strangerPostId);
    // Present today (thin network) — but never as one of the scoped sources.
    expect([null, 'global']).toContain(source);
  });

  test('once the scoped sources are rich the feed stops falling through to everyone', async () => {
    // Seed more in-topic posts than the fall-through threshold.
    for (let i = 0; i < 12; i += 1) {
      cleanup.postIds.push(await insertPost(topicPeer.id, `in-topic filler post ${i}`));
    }
    const body = await fetchFeed(viewer.token, '?limit=50');
    expect(sourceOf(body, strangerPostId)).toBeNull();
    expect(sourceOf(body, topicPeerPostId)).toBe('topic_user');
    expect(sourceOf(body, marketPostId)).toBe('topic_market');
  });

  test('the discover fallback payload is gone', async () => {
    const body = await fetchFeed(viewer.token);
    expect(body.discover).toBeUndefined();
  });
});
