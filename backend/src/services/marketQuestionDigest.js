const db = require('../db');
const { sendEmail } = require('./emailVerificationService');

const QUERY = `
  SELECT status, closing_date AT TIME ZONE 'UTC' AS closes_at
  FROM market_question_submissions
  WHERE status = 'pending'
    OR (status = 'approved' AND finalized_at > closing_date
      AND finalized_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours')`;

function buildDigest(rows, now = new Date()) {
  if (!rows.length) return null;
  const pending = rows.filter((row) => row.status === 'pending');
  const expired = pending.filter((row) => new Date(row.closes_at) <= now).length;
  const urgent = pending.filter((row) => {
    const remaining = new Date(row.closes_at) - now;
    return remaining > 0 && remaining <= 48 * 60 * 60 * 1000;
  }).length;
  const late = rows.length - pending.length;
  return {
    subject: `[Intellacc] Fragen-Freigabe: ${pending.length} offen, ${late} verspätet`,
    text: [
      'Tägliche Kontrolle der Fragen-Freigabe',
      '',
      `WARTET AUF FREIGABE: ${pending.length}`,
      `Davon ABGELAUFEN: ${expired}`,
      `Davon DRINGEND (Schlussdatum binnen 48 Stunden): ${urgent}`,
      `ZU SPÄT FREIGEGEBEN (letzte 24 Stunden): ${late}`,
      '',
      'Bitte offene Fragen rechtzeitig prüfen. Eine unabhängige Zustimmung reicht zur Freigabe.',
      'Fragen prüfen: https://intellacc.com/#predictions',
      '',
      'Offene Fälle werden täglich erneut gemeldet. Ohne offene oder kürzlich verspätet freigegebene Fragen wird keine Mail versandt.'
    ].join('\n')
  };
}

async function runDigest({ to, dryRun = false } = {}) {
  if (!to || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) throw new Error('A single valid recipient is required');
  if (!dryRun && !process.env.SMTP_HOST) throw new Error('SMTP_HOST is required for real delivery');
  let rows;
  try {
    ({ rows } = await db.query(QUERY));
  } catch (error) {
    if (!dryRun) await sendEmail({ to, subject: '[Intellacc] Fragen-Kontrolle fehlgeschlagen', text: 'Die tägliche Datenbankprüfung ist fehlgeschlagen. Bitte Backend und Datenbank prüfen. Es konnte nicht festgestellt werden, ob Fragen festhängen.' });
    throw error;
  }
  const digest = buildDigest(rows);
  if (!digest) return { sent: false, reason: 'no_pending_or_recently_late_questions' };
  if (dryRun) return { sent: false, count: rows.length, ...digest };
  const result = await sendEmail({ to, ...digest });
  if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP did not accept digest recipient');
  return { sent: true, count: rows.length, messageId: result.messageId, response: result.response };
}

module.exports = { buildDigest, runDigest };

if (require.main === module) {
  runDigest({ to: process.argv[2], dryRun: process.argv.includes('--dry-run') })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error('[market-question-digest]', error.message); process.exitCode = 1; })
    .finally(() => db.closePool());
}
