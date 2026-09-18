jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/notificationService', () => ({}));
jest.mock('../src/services/pangramService', () => ({}));
jest.mock('../src/services/activitypub/outboundService', () => ({}));
jest.mock('../src/services/atproto/outboundService', () => ({}));
jest.mock('../src/services/openRouterMatcher/postMatchPipeline', () => ({}));
jest.mock('../src/services/metadata/linkPreviewWorker', () => ({}));

const db = require('../src/db');
const { getFeed } = require('../src/controllers/postController');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const posts = Array.from({ length: 21 }, (_, i) => ({
  id: 200 - i,
  created_at: new Date(Date.UTC(2026, 8, 18, 12, -i)).toISOString(),
  like_count: [1, 3, 12, 15].includes(i) ? 100 : 0
}));

beforeEach(() => db.query.mockReset());

test('selection preserves chronology across pages and only returned posts count as viewed', async () => {
  let page = 0;
  db.query.mockImplementation(async sql => {
    if (sql.includes('FROM user_feed_weights')) return { rows: [{ w_likes: 100 }] };
    if (sql.includes('ORDER BY p.created_at DESC, p.id DESC')) {
      const start = page++ * 10;
      return { rows: posts.slice(start, start + 11) };
    }
    return { rows: [] };
  });
  const first = response();
  await getFeed({ user: { id: 42 }, query: { limit: '2' } }, first);
  expect(first.status).toHaveBeenCalledWith(200);
  const firstPage = first.json.mock.calls[0][0];
  expect(firstPage.items.map(p => p.id)).toEqual([199, 197]);
  expect(firstPage.hasMore).toBe(true);
  expect(JSON.parse(Buffer.from(firstPage.nextCursor, 'base64url')).id).toBe(191);
  const viewCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_post_views'));
  expect(viewCall[1]).toEqual([42, 199, 42, 197]);

  const second = response();
  await getFeed({ user: { id: 42 }, query: { limit: '2', cursor: firstPage.nextCursor } }, second);
  const secondPage = second.json.mock.calls[0][0];
  expect(secondPage.items.map(p => p.id)).toEqual([188, 185]);
  const calls = db.query.mock.calls.filter(([sql]) => sql.includes('ORDER BY p.created_at DESC, p.id DESC'));
  expect(calls[0][1]).toEqual([42, 11, 42]);
  expect(calls[1][1].at(-1)).toBe(191);
  expect(Date.parse(secondPage.items[0].created_at)).toBeLessThan(Date.parse(firstPage.items.at(-1).created_at));
});

test('without saved weights, the feed keeps ordinary chronological pagination', async () => {
  db.query.mockImplementation(async sql => ({
    rows: sql.includes('ORDER BY p.created_at DESC, p.id DESC') ? posts.slice(0, 3) : []
  }));
  const res = response();
  await getFeed({ user: { id: 42 }, query: { limit: '2' } }, res);
  const body = res.json.mock.calls[0][0];
  expect(body.items.map(p => p.id)).toEqual([200, 199]);
  expect(JSON.parse(Buffer.from(body.nextCursor, 'base64url')).id).toBe(199);
  const call = db.query.mock.calls.find(([sql]) => sql.includes('ORDER BY p.created_at DESC, p.id DESC'));
  expect(call[1][1]).toBe(3);
});

test('a small candidate pool returns every post and has no next page', async () => {
  db.query.mockImplementation(async sql => ({ rows: sql.includes('FROM user_feed_weights')
    ? [{ w_likes: 100 }] : sql.includes('ORDER BY p.created_at DESC, p.id DESC') ? posts.slice(0, 2) : [] }));
  const res = response();
  await getFeed({ user: { id: 42 }, query: {} }, res);
  expect(res.json.mock.calls[0][0]).toEqual({ items: posts.slice(0, 2), hasMore: false, nextCursor: null });
});
