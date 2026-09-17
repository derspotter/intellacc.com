jest.mock('../src/db', () => ({ getPool: jest.fn() }));
jest.mock('../src/services/eventEnrichmentService', () => ({ enrichEventInBackground: jest.fn() }));
jest.mock('../src/middleware/auth', () => {
 const auth = (req, res, next) => { req.user = { id: 10, role: req.headers['x-role'] }; next(); };
 auth.requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403);
 return auth;
});
const request = require('supertest');
const express = require('express');
const db = require('../src/db');
const app = express();
app.use(express.json());
app.use('/admin/markets', require('../src/routes/adminMarkets'));
let query;
let row;
beforeEach(() => {
 row = { id: 9, creator_user_id: 10, title: 'Question', status: 'pending', event_type: 'binary', closing_date: '2099-01-01', creator_bond_ledger: '10000000' };
 query = jest.fn(async (sql, params) => {
  if (sql.includes('FROM market_question_submissions WHERE id = $1 FOR UPDATE')) return { rows: [row] };
  if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0, approvals: 0, rejections: 0 }] };
  if (sql.includes('INSERT INTO events')) return { rows: [{ id: 99 }] };
  if (sql.includes('RETURNING *')) return { rows: [{ ...row, status: 'approved' }] };
  if (sql.includes('AS expired_proposals')) return { rows: [{ closed: 120, proposals: 3, expired_proposals: 1 }] };
  if (sql.includes('AS count')) return { rows: [{ count: 120 }] };
  if (sql.includes('SELECT m.id')) return { rows: [{ id: 55, title: 'Hidden market', hidden_at: '2026-01-01' }] };
  return { rows: [] };
 });
 db.getPool.mockReturnValue({ connect: async () => ({ query, release: jest.fn() }) });
});
test('non-admin cannot list or publish', async () => {
 expect((await request(app).get('/admin/markets')).status).toBe(403);
 expect((await request(app).post('/admin/markets/proposals/9/publish')).status).toBe(403);
 expect(query).not.toHaveBeenCalled();
});
test('closed queue is paginated, excludes hidden markets and has full totals', async () => {
 const res = await request(app).get('/admin/markets?queue=closed&limit=25&offset=100&search=test').set('x-role', 'admin');
 expect(res.status).toBe(200);
 expect(res.body).toMatchObject({ total: 120, offset: 100, summary: { closed: 120 } });
 const call = query.mock.calls.find(([sql]) => sql.includes('SELECT m.id'));
 expect(call[0]).toContain('m.outcome IS NULL');
 expect(call[0]).toContain('hidden_at IS NULL');
 expect(call[1]).toEqual(['test', 25, 100]);
});
test('admin can publish own proposal without inventing a vote or charging a stake', async () => {
 const res = await request(app).post('/admin/markets/proposals/9/publish').set('x-role', 'admin').send({});
 expect(res.status).toBe(200);
 expect(res.body.approved_event_id).toBe(99);
 expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO market_question_reviews'))).toBe(false);
 expect(query.mock.calls.some(([sql, args]) => sql.includes('UPDATE users') && args[0] === '20000000')).toBe(true);
 expect(query.mock.calls.some(([sql, args]) => sql.includes('admin_reviewed_by') && args[1] === 10)).toBe(true);
 expect(query).toHaveBeenCalledWith('COMMIT');
});
test('repeated publication returns conflict without paying again', async () => {
 row.status = 'approved';
 expect((await request(app).post('/admin/markets/proposals/9/publish').set('x-role', 'admin')).status).toBe(409);
 expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO events'))).toBe(false);
});
test('expired publication requires acknowledgement', async () => {
 row.closing_date = '2020-01-01'; row.expired = true;
 expect((await request(app).post('/admin/markets/proposals/9/publish').set('x-role', 'admin').send({})).status).toBe(409);
 expect((await request(app).post('/admin/markets/proposals/9/publish').set('x-role', 'admin').send({ acknowledge_expired: true })).status).toBe(200);
});
test('failed publication rolls back', async () => {
 query.mockImplementation(async () => { throw new Error('DB failure'); });
 // Permit rollback so the handler can report the original failure.
 query.mockImplementation(async (sql) => { if (sql === 'ROLLBACK') return { rows: [] }; throw new Error('DB failure'); });
 expect((await request(app).post('/admin/markets/proposals/9/publish').set('x-role', 'admin')).status).toBe(500);
 expect(query).toHaveBeenCalledWith('ROLLBACK');
});

test('admin rejection returns reviewer stakes without creating a market', async () => {
 const res = await request(app).post('/admin/markets/proposals/9/reject').set('x-role', 'admin');
 expect(res.status).toBe(200);
 expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO events'))).toBe(false);
 expect(query.mock.calls.some(([sql]) => sql.includes('payout_ledger = stake_ledger'))).toBe(true);
});
test('connection failure returns a server error', async () => {
 db.getPool.mockReturnValue({ connect: async () => { throw new Error('pool unavailable'); } });
 expect((await request(app).post('/admin/markets/proposals/9/publish').set('x-role', 'admin')).status).toBe(500);
});

jest.mock('../src/services/marketSettlementService', () => ({ settleEvent: jest.fn() }));
const { settleEvent } = require('../src/services/marketSettlementService');
app.patch('/events/:id', require('../src/controllers/predictionsController').resolveEvent);
test('stale direct resolution cannot strand an active community proposal', async () => {
 settleEvent.mockClear();
 query.mockImplementation(async (sql) => {
  if (sql.includes('SELECT id, outcome, event_type')) return { rows: [{ id: 90, outcome: null }] };
  if (sql.includes('FROM market_resolution_proposals')) return { rows: [{ id: 77 }] };
  return { rows: [] };
 });
 const res = await request(app).patch('/events/90').send({ outcome: 'yes' });
 expect(res.status).toBe(409);
 expect(res.body.proposal_id).toBe(77);
 expect(settleEvent).not.toHaveBeenCalled();
 expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(73109, $1)', [90]);
 expect(query).toHaveBeenCalledWith('ROLLBACK');
});
test('direct resolution settles when there is no active community proposal', async () => {
 settleEvent.mockResolvedValue({ event: { id: 90, outcome: 'no' }, engineResult: {} });
 query.mockImplementation(async (sql) => sql.includes('SELECT id, outcome, event_type') ? { rows: [{ id: 90, outcome: null }] } : { rows: [] });
 const res = await request(app).patch('/events/90').send({ outcome: 'no' });
 expect(res.status).toBe(200);
 expect(settleEvent).toHaveBeenCalledWith(90, { outcome: 'no', outcomeId: null, numericalOutcome: null }, undefined);
 expect(query).toHaveBeenCalledWith('COMMIT');
});
