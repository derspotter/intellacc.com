jest.mock('../src/db', () => ({ getPool: jest.fn() }));
const db = require('../src/db');
const { updateSubmission } = require('../src/controllers/marketQuestionEditController');

describe('creator proposal edits', () => {
  let client, row, reviews, req, res;
  beforeEach(() => {
    row = { id: 245, creator_user_id: 7, status: 'pending', total_reviews: 0, approvals: 0, rejections: 0 };
    reviews = [];
    client = { release: jest.fn(), query: jest.fn(async (sql) => {
      if (sql.startsWith('SELECT *')) return { rows: [row].filter(Boolean) };
      if (sql.startsWith('SELECT 1')) return { rows: reviews };
      return { rows: [] };
    }) };
    db.getPool.mockReturnValue({ connect: async () => client });
    req = { params: { id: '245' }, user: { id: 7 }, body: {
      title: ' Corrected title ', details: ' Corrected criteria ', category: ' AI ', closing_date: '2099-12-31T22:59:00Z'
    } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });
  test('updates an expired but unreviewed proposal without touching bonds or events', async () => {
    row.closing_date = '2020-01-01';
    await updateSubmission(req, res);
    expect(res.json).toHaveBeenCalledWith({ message: 'Proposal updated', id: 245 });
    const writes = client.query.mock.calls.filter(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql));
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatch(/^UPDATE market_question_submissions/);
    expect(writes[0][0]).not.toMatch(/bond|balance|event_type|outcome_rows/);
    expect(writes[0][1]).toEqual([245, 'Corrected title', 'Corrected criteria', 'AI', '2099-12-31T22:59:00.000Z']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [245]);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
  test.each([
    ['another creator', 403, () => { req.user.id = 8; }],
    ['published', 409, () => { row.status = 'approved'; }],
    ['linked event', 409, () => { row.approved_event_id = 9; }],
    ['rejected', 409, () => { row.status = 'rejected'; }],
    ['review row', 409, () => { reviews = [{}]; }],
    ['review count', 409, () => { row.total_reviews = 1; }],
    ['missing proposal', 404, () => { row = null; }],
    ['past date', 400, () => { req.body.closing_date = '2020-01-01'; }],
    ['invalid date', 400, () => { req.body.closing_date = 'invalid'; }],
    ['blank title', 400, () => { req.body.title = ' '; }],
    ['blank details', 400, () => { req.body.details = ''; }],
    ['invalid id', 400, () => { req.params.id = '-1'; }]
  ])('rejects %s', async (_label, status, change) => {
    change();
    await updateSubmission(req, res);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    if (status !== 400) expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
