jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/emailVerificationService', () => ({ sendEmail: jest.fn() }));
const db = require('../src/db');
const { sendEmail } = require('../src/services/emailVerificationService');
const { buildDigest, runDigest } = require('../src/services/marketQuestionDigest');
const now = new Date('2026-09-16T07:00:00Z');
const base = { id: 1, title: 'Example', username: 'author', status: 'pending', submitted_at: now, closes_at: '2026-09-20T07:00:00Z', approvals: 0 };
beforeEach(() => { jest.clearAllMocks(); process.env.SMTP_HOST = 'postfix'; });
test('quiet when no questions need attention', async () => {
 db.query.mockResolvedValue({ rows: [] });
 expect(await runDigest({ to: 'admin@example.com' })).toMatchObject({ sent: false });
 expect(sendEmail).not.toHaveBeenCalled();
});
test.each([
 [{}, 'WARTET AUF FREIGABE: 1'],
 [{ closes_at: '2026-09-17T07:00:00Z' }, 'DRINGEND (Schlussdatum binnen 48 Stunden): 1'],
 [{ closes_at: '2026-09-15T07:00:00Z' }, 'ABGELAUFEN: 1'],
 [{ status: 'approved', decided_at: now }, 'ZU SPÄT FREIGEGEBEN (letzte 24 Stunden): 1']
])('labels state %j', (fields, label) => expect(buildDigest([{ ...base, ...fields }], now).text).toContain(label));
test('sends actionable report and verifies SMTP acceptance', async () => {
 db.query.mockResolvedValue({ rows: [base] });
 sendEmail.mockResolvedValue({ accepted: ['admin@example.com'], rejected: [], messageId: 'ok' });
 expect(await runDigest({ to: 'admin@example.com' })).toMatchObject({ sent: true, count: 1 });
 expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@example.com', text: expect.stringContaining('WARTET AUF FREIGABE: 1') }));
});
test('dry run does not send', async () => {
 db.query.mockResolvedValue({ rows: [base] });
 await runDigest({ to: 'admin@example.com', dryRun: true });
 expect(sendEmail).not.toHaveBeenCalled();
});
test('failed check sends failure notification, not a clean report', async () => {
 db.query.mockRejectedValue(new Error('database unavailable'));
 await expect(runDigest({ to: 'admin@example.com' })).rejects.toThrow('database unavailable');
 expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('fehlgeschlagen') }));
});
test('SMTP rejection fails the job', async () => {
 db.query.mockResolvedValue({ rows: [base] });
 sendEmail.mockResolvedValue({ accepted: [], rejected: ['admin@example.com'] });
 await expect(runDigest({ to: 'admin@example.com' })).rejects.toThrow('SMTP');
});

test('email excludes question titles, authors and identifiers', () => {
 const result = buildDigest([base], now);
 expect(result.text).not.toContain(base.title);
 expect(result.text).not.toContain(base.username);
 expect(result.text).not.toContain('#1');
});
