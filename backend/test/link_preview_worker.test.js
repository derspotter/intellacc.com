jest.mock('../src/services/metadata/metadataService', () => ({
  extractFirstUrl: (text) => text?.match(/https?:\/\/[^\s]+/)?.[0] || null,
  fetchMetadata: jest.fn()
}));
jest.mock('../src/services/pangramService', () => ({ analyzeContent: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/services/openRouterMatcher/postMatchPipeline', () => ({ processPost: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/services/activitypub/outboundService', () => ({ enqueueCreateForLocalPost: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/services/atproto/outboundService', () => ({ enqueueCreateForLocalPost: jest.fn().mockResolvedValue(null) }));

const { randomUUID } = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/db');
const { app } = require('../src/index');
const { fetchMetadata } = require('../src/services/metadata/metadataService');
const { createPreviewWorker, previewUrl } = require('../src/services/metadata/linkPreviewWorker');

jest.setTimeout(20000);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const waitFor = async (check) => {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Worker did not reach external request');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('durable background link previews', () => {
  let userId, token, worker, oldMax;
  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })) };
  const urls = [];
  const url = () => { const value = `https://preview.example/${randomUUID()}`; urls.push(value); return value; };
  const create = async (content) => {
    const response = await request(app).post('/api/posts').set('Authorization', `Bearer ${token}`).send({ content });
    expect(response.status).toBe(201);
    return response.body;
  };
  const edit = async (id, content) => {
    const response = await request(app).patch(`/api/posts/${id}`).set('Authorization', `Bearer ${token}`).send({ content });
    expect(response.status).toBe(200);
    return response.body;
  };
  const post = async (id) => (await db.query(`SELECT p.link_url, p.link_metadata_id, lm.title
    FROM posts p LEFT JOIN link_metadata lm ON lm.id=p.link_metadata_id WHERE p.id=$1`, [id])).rows[0];
  const jobs = async () => (await db.query(`SELECT j.* FROM post_link_preview_jobs j
    JOIN posts p ON p.id=j.post_id WHERE p.user_id=$1 ORDER BY post_id`, [userId])).rows;
  beforeAll(async () => {
    const name = `preview_${randomUUID().slice(0, 8)}`;
    userId = (await db.query("INSERT INTO users (username,email,password_hash,verification_tier) VALUES ($1,$2,'test',1) RETURNING id", [name, `${name}@example.test`])).rows[0].id;
    token = jwt.sign({ userId, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    oldMax = db.getPool().options.max;
    db.getPool().options.max = 1;
    db.getPool().options.connectionTimeoutMillis = 3000;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMetadata.mockReset().mockResolvedValue({ title: 'Preview', description: 'Description', image_url: null, site_name: 'Example' });
    worker = createPreviewWorker({ io });
  });
  afterEach(async () => {
    worker.stop();
    await db.query('DELETE FROM posts WHERE user_id=$1', [userId]);
    await db.query('DELETE FROM link_metadata WHERE url=ANY($1::text[])', [urls]);
  });
  afterAll(async () => {
    await db.query('DELETE FROM users WHERE id=$1', [userId]);
    db.getPool().options.max = oldMax;
  });

  test('publishes before any HTTP fetch, then persists and notifies without holding a pool connection', async () => {
    const pending = deferred();
    fetchMetadata.mockReturnValue(pending.promise);
    const p = await create(`Published immediately ${url()}`);
    expect(p.link_metadata_id).toBeNull();
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(1);
    const running = worker.runOnce();
    try {
      await waitFor(() => fetchMetadata.mock.calls.length === 1);
      expect(db.getPool().totalCount - db.getPool().idleCount).toBe(0);
      expect((await db.query('SELECT 42 AS value')).rows[0].value).toBe(42);
      expect((await request(app).get('/api/health-check')).status).toBe(200);
    } finally { pending.resolve({ title: 'Ready' }); }
    await running;
    expect((await post(p.id)).title).toBe('Ready');
    expect(await jobs()).toHaveLength(0);
    expect(io.to).toHaveBeenCalledWith(`user:${userId}`);
    expect(emit).toHaveBeenCalledWith('post_preview_updated', { post_id: p.id });
  });

  test('fresh normalized URLs reuse metadata without sliding its cache expiry', async () => {
    const source = url();
    await db.query("INSERT INTO link_metadata (url,title,updated_at) VALUES ($1,'Cached',NOW()-INTERVAL '1 hour')", [source]);
    const before = (await db.query('SELECT updated_at FROM link_metadata WHERE url=$1', [source])).rows[0].updated_at;
    const p = await create(`${source}#section`);
    await worker.runOnce();
    expect((await post(p.id)).title).toBe('Cached');
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect((await db.query('SELECT updated_at FROM link_metadata WHERE url=$1', [source])).rows[0].updated_at).toEqual(before);
  });

  test('expired metadata is refreshed', async () => {
    const source = url();
    await db.query("INSERT INTO link_metadata (url,title,updated_at) VALUES ($1,'Expired',NOW()-INTERVAL '2 days')", [source]);
    const p = await create(source);
    await worker.runOnce();
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect((await post(p.id)).title).toBe('Preview');
  });

  test('two posts for the same URL share an in-flight download', async () => {
    const source = url();
    const pending = deferred();
    fetchMetadata.mockReturnValue(pending.promise);
    const first = await create(source);
    const second = await create(`${source}#fragment`);
    const running = worker.runOnce();
    await waitFor(() => fetchMetadata.mock.calls.length === 1);
    pending.resolve({ title: 'Shared' });
    await running;
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect((await post(first.id)).link_metadata_id).toBe((await post(second.id)).link_metadata_id);
  });

  test('bounds concurrency and suppresses overlapping ticks', async () => {
    for (let i = 0; i < 3; i++) await create(url());
    const pending = deferred();
    fetchMetadata.mockReturnValue(pending.promise);
    const running = worker.runOnce();
    expect(worker.runOnce()).toBe(running);
    await waitFor(() => fetchMetadata.mock.calls.length === 2);
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
    pending.resolve({ title: 'Bounded' });
    await running;
    expect(await jobs()).toHaveLength(1);
    await worker.runOnce();
    expect(fetchMetadata).toHaveBeenCalledTimes(3);
  });

  test('another worker cannot claim a live lease, but recovers an expired lease', async () => {
    await create(url());
    const pending = deferred();
    fetchMetadata.mockReturnValueOnce(pending.promise);
    const running = worker.runOnce();
    await waitFor(() => fetchMetadata.mock.calls.length === 1);
    const other = createPreviewWorker();
    await other.runOnce();
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    await db.query("UPDATE post_link_preview_jobs SET locked_until=NOW()-INTERVAL '1 second' WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)", [userId]);
    await other.runOnce();
    pending.resolve({ title: 'Expired worker' });
    await running;
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
    expect(await jobs()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  test('a failed retry write keeps the overlap guard until the other fetch finishes', async () => {
    await create(url());
    await create(url());
    const pending = deferred();
    fetchMetadata.mockRejectedValueOnce(new Error('Fetch failed')).mockReturnValueOnce(pending.promise);
    const original = db.query;
    const spy = jest.spyOn(db, 'query').mockImplementation((sql, params) => {
      if (sql.startsWith('UPDATE post_link_preview_jobs SET lease_id')) return Promise.reject(new Error('Retry write failed'));
      return original(sql, params);
    });
    const running = worker.runOnce();
    const result = running.catch((error) => error);
    try {
      await waitFor(() => fetchMetadata.mock.calls.length === 2);
      await new Promise((resolve) => setImmediate(resolve));
      expect(worker.runOnce()).toBe(running);
    } finally {
      pending.resolve({ title: 'Other slot' });
      expect((await result).message).toBe('Retry write failed');
      spy.mockRestore();
    }
  });

  test('late completion cannot overwrite an edit, including URL A -> B -> A', async () => {
    const source = url();
    const p = await create(source);
    const pending = deferred();
    fetchMetadata.mockReturnValueOnce(pending.promise);
    const running = worker.runOnce();
    await waitFor(() => fetchMetadata.mock.calls.length === 1);
    await edit(p.id, url());
    await edit(p.id, source);
    pending.resolve({ title: 'Stale' });
    await running;
    expect((await post(p.id)).link_metadata_id).toBeNull();
    expect(await jobs()).toHaveLength(1);
    await worker.runOnce();
    expect((await post(p.id)).title).toBe('Preview');
  });

  test('removing a URL cancels its job and clears the preview', async () => {
    const p = await create(url());
    await worker.runOnce();
    expect((await post(p.id)).link_metadata_id).not.toBeNull();
    await edit(p.id, 'No link now');
    expect(await post(p.id)).toMatchObject({ link_url: null, link_metadata_id: null });
    expect(await jobs()).toHaveLength(0);
  });

  test('failures retry with backoff and stop after three attempts', async () => {
    await create(url());
    fetchMetadata.mockResolvedValue(null);
    for (let i = 1; i <= 3; i++) {
      await worker.runOnce();
      expect((await jobs())[0]).toMatchObject({ attempts: i, lease_id: null, last_error: 'No usable preview metadata' });
      expect(new Date((await jobs())[0].available_at).getTime()).toBeGreaterThan(Date.now());
      await worker.runOnce();
      expect(fetchMetadata).toHaveBeenCalledTimes(i);
      await db.query('UPDATE post_link_preview_jobs SET available_at=NOW() WHERE post_id IN (SELECT id FROM posts WHERE user_id=$1)', [userId]);
    }
    await worker.runOnce();
    expect(fetchMetadata).toHaveBeenCalledTimes(3);
  });

  test('posts without usable URLs do not enqueue work', async () => {
    expect(previewUrl('https://EXAMPLE.com:443/path#x')).toBe('https://example.com/path');
    await create('Plain post');
    await create('Invalid https://');
    expect(await jobs()).toHaveLength(0);
    await worker.runOnce();
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  test('editing text around an enriched URL does not enqueue another preview', async () => {
    const source = url();
    const p = await create(source);
    await worker.runOnce();
    const metadataId = (await post(p.id)).link_metadata_id;
    await edit(p.id, `Typo corrected ${source}`);
    expect(await jobs()).toHaveLength(0);
    expect((await post(p.id)).link_metadata_id).toBe(metadataId);
    await worker.runOnce();
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
  });

  test('stores the real failure reason for diagnosis', async () => {
    await create(url());
    fetchMetadata.mockRejectedValueOnce(new Error('SSRF blocked: private address'));
    await worker.runOnce();
    expect((await jobs())[0].last_error).toBe('SSRF blocked: private address');
  });
});
