jest.mock('../src/db', () => ({ getPool: jest.fn() }));
jest.mock('../src/services/eventEnrichmentService', () => ({ enrichEventInBackground: jest.fn() }));
const db = require('../src/db');
const controller = require('../src/controllers/marketQuestionController');

const submission = { id: 174, creator_user_id: 10, status: 'pending', required_validators: 1, required_approvals: 1, creator_bond_ledger: '10000000', event_type: 'binary', title: 'Example', details: 'Criteria', closing_date: '2027-01-01' };
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

test('bootstrap config requires one independent approval', async () => {
  const res = response();
  await controller.getConfig({}, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requiredValidators: 1, requiredApprovals: 1 }));
});

test.each([[1, 1, true, true], [1, 0, true, false]])('settles %i reviews with %i approvals', async (total, approvals, finalized, approved) => {
  const query = jest.fn(async (sql, params) => {
    if (sql.includes('SELECT * FROM market_question_submissions')) return { rows: [submission] };
    if (sql.includes('SELECT 1 FROM market_question_reviews')) return { rows: [] };
    if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total, approvals, rejections: total - approvals }] };
    if (sql.includes('INSERT INTO events')) return { rows: [{ id: 900 }] };
    return { rows: [{ ...submission, rp_balance_ledger: '100000000', status: finalized ? (approved ? 'approved' : 'rejected') : 'pending' }] };
  });
  const client = { query, release: jest.fn() };
  db.getPool.mockReturnValue({ connect: async () => client });
  const res = response();
  await controller.submitReview({ user: { id: 20 }, params: { id: '174' }, body: { vote: 'approve' } }, res);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ finalized, ...(finalized ? { approved } : {}) }));
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO events'))).toBe(approved === true);
  if (approved) {
    expect(query.mock.calls.some(([sql, args]) => sql.includes('UPDATE users') && args?.[0] === '20000000')).toBe(true);
    expect(query.mock.calls.some(([sql, args]) => sql.includes('UPDATE market_question_reviews') && args?.[2] === '5000000')).toBe(true);
  }
  expect(query).toHaveBeenCalledWith('COMMIT');
});
