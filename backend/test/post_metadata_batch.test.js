const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../src/db');
const { getTestServer, releaseTestServer } = require('./testServer');

jest.setTimeout(15000);

describe('batched post metadata', () => {
  let baseUrl;
  let token;
  const users = [];
  const posts = [];
  const events = [];
  const call = async (body, auth = token) => {
    const response = await fetch(`${baseUrl}/api/posts/metadata`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  beforeAll(async () => {
    ({ baseUrl } = await getTestServer());
    for (let i = 0; i < 4; i++) {
      const name = `metadata_${randomUUID().slice(0, 8)}`;
      users.push((await db.query("INSERT INTO users (username,email,password_hash) VALUES ($1,$2,'test') RETURNING id", [name, `${name}@example.test`])).rows[0].id);
    }
    token = jwt.sign({ userId: users[0], role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    for (let i = 0; i < 23; i++) {
      posts.push((await db.query("INSERT INTO posts (user_id,content,is_hidden) VALUES ($1,'Metadata fixture',$2) RETURNING id",
        [i === 20 ? users[2] : i === 21 ? users[3] : users[1], i === 22])).rows[0].id);
    }
    await db.query('INSERT INTO user_blocks (blocker_id,blocked_user_id) VALUES ($1,$2),($3,$1)', [users[0], users[2], users[3]]);
    for (let i = 0; i < 5; i++) {
      events.push((await db.query("INSERT INTO events (title,closing_date,event_type,hidden_at) VALUES ($1,NOW()+INTERVAL '1 day','binary',$2) RETURNING id", [`Market ${i}`, i === 4 ? new Date() : null])).rows[0].id);
      await db.query('INSERT INTO post_market_matches (post_id,event_id,match_score,match_method) VALUES ($1,$2,$3,\'test\')', [posts[0], events[i], 0.5 + i / 10]);
    }
    await db.query("INSERT INTO post_market_links (post_id,event_id,stance,source,confirmed,match_method) VALUES ($1,$2,'agrees','author_confirmed',TRUE,'manual'),($1,$3,'related','auto_match',FALSE,'test')", [posts[0], events[0], events[1]]);
    await db.query("INSERT INTO post_market_links (post_id,event_id,stance,source,confirmed,match_method) VALUES ($1,$2,'agrees','author_confirmed',TRUE,'manual')", [posts[1], events[4]]);
    await db.query("INSERT INTO post_analysis (post_id,processing_status) VALUES ($1,'reasoning')", [posts[0]]);
    const update = (await db.query(`INSERT INTO market_updates
      (user_id,event_id,prev_prob,new_prob,stake_amount,shares_acquired,share_type,hold_until)
      VALUES ($1,$2,0.5,0.65,1,1,'yes',NOW()) RETURNING id`, [users[0], events[0]])).rows[0].id;
    const episode = (await db.query(`INSERT INTO post_signal_episodes
      (market_update_id,post_id,event_id,trader_user_id,episode_bucket_start,episode_type,is_meaningful,p_before,p_after)
      VALUES ($1,$2,$3,$4,NOW(),'belief',TRUE,0.5,0.65) RETURNING id`, [update, posts[0], events[0], users[0]])).rows[0].id;
    // Multiple payout components must not multiply the episode count.
    await db.query(`INSERT INTO post_signal_reward_payouts
      (episode_id,post_id,author_user_id,event_id,component,score_component,mint_rate_snapshot,reward_ledger)
      VALUES ($1,$2,$3,$4,'early',1,1,1000000),($1,$2,$3,$4,'mid',1,1,2000000)`,
    [episode, posts[0], users[1], events[0]]);
  });
  afterAll(async () => {
    await db.query('DELETE FROM posts WHERE id=ANY($1::int[])', [posts]);
    await db.query('DELETE FROM events WHERE id=ANY($1::int[])', [events]);
    await db.query('DELETE FROM users WHERE id=ANY($1::int[])', [users]);
    await releaseTestServer();
  });
  test('one data query serves twenty posts, preserving ranking, manual links and defaults', async () => {
    const spy = jest.spyOn(db, 'query');
    try {
      const result = await call({ post_ids: posts.slice(0, 20) });
      expect(result.status).toBe(200);
      expect(result.body.posts).toHaveLength(20);
      const first = result.body.posts[0];
      expect(first.status.processing_status).toBe('reasoning');
      expect(first.link).toMatchObject({ event_id: events[0], confirmed: true, match_method: 'manual' });
      expect(first.markets.map((m) => m.event_id)).toEqual([events[3], events[2], events[1]]);
      expect(first.signal).toMatchObject({ episode_count: 1, market_count: 1, reward_rp: 3 });
      expect(first.signal.max_prob_move).toBeCloseTo(0.15);
      expect(result.body.posts[1].link).toBeNull();
      expect(result.body.posts[2]).toMatchObject({ status: { processing_status: 'not_started' }, markets: [], signal: { episode_count: 0 } });
      // Count data queries independently of authentication middleware details.
      expect(spy.mock.calls.filter(([sql]) => sql.includes('FROM posts p'))).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  test.each([false, true])('omits hidden, blocked in either direction and nonexistent posts (status_only=%s)', async (statusOnly) => {
    const result = await call({ post_ids: [posts[0], ...posts.slice(20), 2147483647], status_only: statusOnly });
    expect(result.status).toBe(200);
    expect(result.body.posts.map((p) => p.post_id)).toEqual([posts[0]]);
    if (statusOnly) expect(Object.keys(result.body.posts[0]).sort()).toEqual(['post_id', 'status']);
  });
  test('administrator bypass matches feed semantics but hidden posts remain excluded', async () => {
    const admin = jwt.sign({ userId: users[0], role: 'admin' }, process.env.JWT_SECRET);
    const result = await call({ post_ids: posts.slice(20) }, admin);
    expect(result.body.posts.map((p) => p.post_id)).toEqual(posts.slice(20, 22));
  });
  test('status polls omit expensive metadata joins and expose completed status', async () => {
    await db.query("UPDATE post_analysis SET processing_status='complete' WHERE post_id=$1", [posts[0]]);
    const spy = jest.spyOn(db, 'query');
    try {
      const result = await call({ post_ids: [posts[0], posts[0]], status_only: true });
      expect(result.body.posts).toHaveLength(1);
      expect(result.body.posts[0].status.processing_status).toBe('complete');
      const metadataSql = spy.mock.calls.find(([sql]) => sql.includes('FROM posts p'))[0];
      expect(metadataSql).not.toMatch(/post_market_links|post_signal_episodes|post_market_matches/);
    } finally { spy.mockRestore(); }
  });
  test('requires authentication and rejects malformed or oversized batches', async () => {
    expect((await call({ post_ids: posts }, null)).status).toBe(401);
    for (const body of [{}, { post_ids: [] }, { post_ids: ['1'] }, { post_ids: [-1] },
      { post_ids: [1.5] }, { post_ids: Array(101).fill(1) }, { post_ids: [1], status_only: 'true' }]) {
      expect((await call(body)).status).toBe(400);
    }
  });
});
