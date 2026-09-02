// Community market resolution: any user proposes an outcome for a past-close
// market with a source; a randomly drawn jury of active, uninvolved users
// confirms or rejects at stake; confirmed proposals settle through the
// engine after a public challenge window; disputes, challenges, and
// timeouts escalate to admin. Mirrors marketQuestionController's economics.
const db = require('../db');
const { settleEvent } = require('../services/marketSettlementService');

const LEDGER_SCALE = 1_000_000n;
// Resolution moves real market payouts, so its stakes sit far above the
// 10 RP question-creation bond: propose at 50, judge at 10.
const PROPOSER_STAKE_RP = 50n;
const PROPOSER_REWARD_RP = 10n; // Paid on top of the refund when confirmed
const VOTER_STAKE_RP = 10n;
const VOTER_PAYOUT_RP = 25n; // Returned to winning-side voters (includes stake)
const JURY_DRAW_CAP = 9;
const CONFIRMS_TO_PASS = 3;
const REJECTS_TO_ESCALATE = 2;
const VOTING_WINDOW_HOURS = 72;
const CHALLENGE_WINDOW_HOURS = 24;
const JURY_ACTIVITY_DAYS = 7;
const PROPOSER_COOLDOWN_DAYS = 7;

const toLedgerString = (rp) => (rp * LEDGER_SCALE).toString();

// A user is "involved" in a market when they hold shares, traded it, or
// predicted on it — involvement disqualifies both proposing and jury duty.
const INVOLVEMENT_SQL = `(
  EXISTS (SELECT 1 FROM user_shares x WHERE x.event_id = $EVENT AND x.user_id = $USER)
  OR EXISTS (SELECT 1 FROM user_outcome_shares x WHERE x.event_id = $EVENT AND x.user_id = $USER)
  OR EXISTS (SELECT 1 FROM market_updates x WHERE x.event_id = $EVENT AND x.user_id = $USER)
  OR EXISTS (SELECT 1 FROM market_outcome_updates x WHERE x.event_id = $EVENT AND x.user_id = $USER)
  OR EXISTS (SELECT 1 FROM distribution_trades x WHERE x.event_id = $EVENT AND x.user_id = $USER)
  OR EXISTS (SELECT 1 FROM predictions x WHERE x.event_id = $EVENT AND x.user_id = $USER)
)`;

const involvementSql = (eventParam, userParam) =>
  INVOLVEMENT_SQL.replaceAll('$EVENT', eventParam).replaceAll('$USER', userParam);

const isUserInvolved = async (client, eventId, userId) => {
  const res = await client.query(
    `SELECT ${involvementSql('$1', '$2')} AS involved`,
    [eventId, userId]
  );
  return res.rows[0].involved === true;
};

const normalizeProposal = (row) => ({
  id: row.id,
  event_id: row.event_id,
  proposer_user_id: row.proposer_user_id,
  proposed_outcome: row.proposed_outcome,
  proposed_outcome_id: row.proposed_outcome_id !== null ? Number(row.proposed_outcome_id) : null,
  source_url: row.source_url,
  note: row.note,
  status: row.status,
  jury_size: row.jury_size,
  confirms: row.confirms,
  rejects: row.rejects,
  voting_deadline_at: row.voting_deadline_at,
  challenge_ends_at: row.challenge_ends_at,
  escalation_reason: row.escalation_reason,
  created_at: row.created_at
});

exports.createProposal = async (req, res) => {
  const proposerUserId = req.user.id;
  const eventId = Number(req.params.eventId);
  const { outcome = null, outcome_id = null, source_url, note = null } = req.body || {};

  if (!Number.isFinite(eventId)) {
    return res.status(400).json({ message: 'Invalid event id' });
  }
  const outcomeId = Number.isInteger(outcome_id) ? outcome_id : Number.parseInt(outcome_id, 10);
  const hasOutcomeId = Number.isInteger(outcomeId) && outcomeId > 0;
  const hasBinaryOutcome = outcome === 'yes' || outcome === 'no';
  if (hasOutcomeId === hasBinaryOutcome) {
    return res.status(400).json({ message: "Provide exactly one of outcome ('yes'/'no') or outcome_id" });
  }
  if (!source_url || !/^https?:\/\/\S+$/i.test(String(source_url).trim())) {
    return res.status(400).json({ message: 'A source_url (http/https) backing the resolution is required' });
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');

    const eventRes = await client.query(
      'SELECT id, outcome, closing_date, event_type FROM events WHERE id = $1 FOR UPDATE',
      [eventId]
    );
    if (eventRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Event not found' });
    }
    const event = eventRes.rows[0];
    if (event.outcome) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Event already resolved' });
    }
    if (new Date(event.closing_date) > new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Market has not closed yet' });
    }
    if (event.event_type === 'numeric') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Numeric markets are resolved by admin' });
    }

    if (await isUserInvolved(client, eventId, proposerUserId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Users with a position in this market cannot propose its resolution' });
    }

    const cooldownRes = await client.query(
      `SELECT 1 FROM market_resolution_proposals
       WHERE proposer_user_id = $1 AND status = 'overturned'
         AND decided_at > NOW() - ($2 || ' days')::interval
       LIMIT 1`,
      [proposerUserId, String(PROPOSER_COOLDOWN_DAYS)]
    );
    if (cooldownRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Proposal cooldown: a recent proposal of yours was overturned' });
    }

    const activeRes = await client.query(
      `SELECT 1 FROM market_resolution_proposals
       WHERE event_id = $1 AND status IN ('voting', 'challenge_window', 'escalated') LIMIT 1`,
      [eventId]
    );
    if (activeRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This market already has an active resolution proposal' });
    }

    const stakeLedger = toLedgerString(PROPOSER_STAKE_RP);
    const balanceRes = await client.query(
      `UPDATE users SET rp_balance_ledger = rp_balance_ledger - $1::bigint
       WHERE id = $2 AND rp_balance_ledger >= $1::bigint RETURNING id`,
      [stakeLedger, proposerUserId]
    );
    if (balanceRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Insufficient RP balance for proposer stake' });
    }

    // Random jury draw: recently active, not the proposer, not involved.
    const juryRes = await client.query(
      `SELECT u.id FROM users u
       WHERE u.deleted_at IS NULL
         AND u.id <> $2
         AND u.last_active_at > NOW() - ($3 || ' days')::interval
         AND NOT ${involvementSql('$1', 'u.id')}
       ORDER BY random()
       LIMIT $4`,
      [eventId, proposerUserId, String(JURY_ACTIVITY_DAYS), JURY_DRAW_CAP]
    );
    const jurorIds = juryRes.rows.map((r) => r.id);

    const proposalRes = await client.query(
      `INSERT INTO market_resolution_proposals
        (event_id, proposer_user_id, proposed_outcome, proposed_outcome_id, source_url, note,
         proposer_stake_ledger, jury_size, voting_deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9 || ' hours')::interval)
       RETURNING *`,
      [
        eventId,
        proposerUserId,
        hasBinaryOutcome ? outcome : null,
        hasOutcomeId ? outcomeId : null,
        String(source_url).trim(),
        note ? String(note).trim() : null,
        stakeLedger,
        jurorIds.length,
        String(VOTING_WINDOW_HOURS)
      ]
    );
    const proposal = proposalRes.rows[0];

    for (const jurorId of jurorIds) {
      await client.query(
        'INSERT INTO market_resolution_jurors (proposal_id, user_id) VALUES ($1, $2)',
        [proposal.id, jurorId]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({ proposal: normalizeProposal(proposal), jurors: jurorIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating resolution proposal:', err);
    return res.status(500).json({ message: 'Failed to create resolution proposal' });
  } finally {
    client.release();
  }
};

exports.submitVote = async (req, res) => {
  const voterUserId = req.user.id;
  const proposalId = Number(req.params.id);
  const { vote, note = null } = req.body || {};

  if (!Number.isFinite(proposalId)) {
    return res.status(400).json({ message: 'Invalid proposal id' });
  }
  if (!['confirm', 'reject'].includes(vote)) {
    return res.status(400).json({ message: "vote must be 'confirm' or 'reject'" });
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');

    const proposalRes = await client.query(
      'SELECT * FROM market_resolution_proposals WHERE id = $1 FOR UPDATE',
      [proposalId]
    );
    if (proposalRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Proposal not found' });
    }
    const proposal = proposalRes.rows[0];
    if (proposal.status !== 'voting') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Proposal is not open for voting (status: ${proposal.status})` });
    }

    const jurorRes = await client.query(
      'SELECT 1 FROM market_resolution_jurors WHERE proposal_id = $1 AND user_id = $2',
      [proposalId, voterUserId]
    );
    if (jurorRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Only drawn jurors can vote on this proposal' });
    }

    const existingVote = await client.query(
      'SELECT 1 FROM market_resolution_votes WHERE proposal_id = $1 AND voter_user_id = $2',
      [proposalId, voterUserId]
    );
    if (existingVote.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'You already voted on this proposal' });
    }

    const stakeLedger = toLedgerString(VOTER_STAKE_RP);
    const balanceRes = await client.query(
      `UPDATE users SET rp_balance_ledger = rp_balance_ledger - $1::bigint
       WHERE id = $2 AND rp_balance_ledger >= $1::bigint RETURNING id`,
      [stakeLedger, voterUserId]
    );
    if (balanceRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Insufficient RP balance for voter stake' });
    }

    await client.query(
      `INSERT INTO market_resolution_votes (proposal_id, voter_user_id, vote, note, stake_ledger)
       VALUES ($1, $2, $3, $4, $5)`,
      [proposalId, voterUserId, vote, note ? String(note).trim() : null, stakeLedger]
    );

    const confirms = proposal.confirms + (vote === 'confirm' ? 1 : 0);
    const rejects = proposal.rejects + (vote === 'reject' ? 1 : 0);

    let status = proposal.status;
    let escalationReason = null;
    let challengeEnds = false;
    if (rejects >= REJECTS_TO_ESCALATE) {
      status = 'escalated';
      escalationReason = 'disputed';
    } else if (confirms >= CONFIRMS_TO_PASS) {
      status = 'challenge_window';
      challengeEnds = true;
    }

    const updated = await client.query(
      `UPDATE market_resolution_proposals
       SET confirms = $2, rejects = $3, status = $4,
           escalation_reason = COALESCE($5, escalation_reason),
           challenge_ends_at = CASE WHEN $6 THEN NOW() + ($7 || ' hours')::interval ELSE challenge_ends_at END,
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [proposalId, confirms, rejects, status, escalationReason, challengeEnds, String(CHALLENGE_WINDOW_HOURS)]
    );

    await client.query('COMMIT');
    return res.status(201).json({ proposal: normalizeProposal(updated.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error voting on resolution proposal:', err);
    return res.status(500).json({ message: 'Failed to vote on proposal' });
  } finally {
    client.release();
  }
};

exports.challengeProposal = async (req, res) => {
  const userId = req.user.id;
  const proposalId = Number(req.params.id);

  if (!Number.isFinite(proposalId)) {
    return res.status(400).json({ message: 'Invalid proposal id' });
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const proposalRes = await client.query(
      'SELECT * FROM market_resolution_proposals WHERE id = $1 FOR UPDATE',
      [proposalId]
    );
    if (proposalRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Proposal not found' });
    }
    const proposal = proposalRes.rows[0];
    if (proposal.status !== 'challenge_window') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Proposal is not in its challenge window' });
    }
    if (proposal.proposer_user_id === userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'The proposer cannot challenge their own proposal' });
    }

    const updated = await client.query(
      `UPDATE market_resolution_proposals
       SET status = 'escalated', escalation_reason = 'challenged', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [proposalId]
    );
    await client.query('COMMIT');
    return res.status(200).json({ proposal: normalizeProposal(updated.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error challenging resolution proposal:', err);
    return res.status(500).json({ message: 'Failed to challenge proposal' });
  } finally {
    client.release();
  }
};

// Settle voter stakes for a decided proposal: winners get VOTER_PAYOUT_RP
// back (stake included), losers forfeit. Winning side = 'confirm' when the
// proposal carried, 'reject' when it was overturned/rejected.
const settleVotes = async (client, proposalId, winningVote) => {
  const payoutLedger = toLedgerString(VOTER_PAYOUT_RP);
  await client.query(
    `UPDATE users u SET rp_balance_ledger = rp_balance_ledger + $2::bigint
     FROM market_resolution_votes v
     WHERE v.proposal_id = $1 AND v.vote = $3 AND v.settled_at IS NULL AND u.id = v.voter_user_id`,
    [proposalId, payoutLedger, winningVote]
  );
  await client.query(
    `UPDATE market_resolution_votes
     SET payout_ledger = CASE WHEN vote = $2 THEN $3::bigint ELSE 0 END,
         settled_at = NOW()
     WHERE proposal_id = $1 AND settled_at IS NULL`,
    [proposalId, winningVote, payoutLedger]
  );
};

const refundProposer = async (client, proposal, { withReward = false } = {}) => {
  const rewardLedger = withReward ? PROPOSER_REWARD_RP * LEDGER_SCALE : 0n;
  await client.query(
    `UPDATE users SET rp_balance_ledger = rp_balance_ledger + $1::bigint + $2::bigint WHERE id = $3`,
    [proposal.proposer_stake_ledger, rewardLedger.toString(), proposal.proposer_user_id]
  );
};

// Settle proposals whose challenge window elapsed quietly, and escalate
// proposals that never reached quorum before the voting deadline.
// Called by the daily cron (admin sweep endpoint) and directly by tests.
exports.sweepDueProposals = async (io = null) => {
  const stats = { settled: 0, escalated: 0, errors: 0 };

  const due = await db.query(
    `SELECT id FROM market_resolution_proposals
     WHERE status = 'challenge_window' AND challenge_ends_at <= NOW()`
  );
  for (const row of due.rows) {
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      const proposalRes = await client.query(
        `SELECT * FROM market_resolution_proposals WHERE id = $1 AND status = 'challenge_window' FOR UPDATE`,
        [row.id]
      );
      if (proposalRes.rows.length === 0) {
        await client.query('ROLLBACK');
        continue;
      }
      const proposal = proposalRes.rows[0];

      await settleEvent(proposal.event_id, {
        outcome: proposal.proposed_outcome,
        outcomeId: proposal.proposed_outcome_id !== null ? Number(proposal.proposed_outcome_id) : null
      }, io);

      await refundProposer(client, proposal, { withReward: true });
      await settleVotes(client, proposal.id, 'confirm');
      await client.query(
        `UPDATE market_resolution_proposals
         SET status = 'confirmed', proposer_stake_settled = TRUE, decided_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [proposal.id]
      );
      await client.query('COMMIT');
      stats.settled += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      stats.errors += 1;
      console.error(`Resolution sweep: failed to settle proposal ${row.id}:`, err.message);
    } finally {
      client.release();
    }
  }

  const timedOut = await db.query(
    `UPDATE market_resolution_proposals
     SET status = 'escalated', escalation_reason = 'timeout', updated_at = NOW()
     WHERE status = 'voting' AND voting_deadline_at <= NOW()
     RETURNING id`
  );
  stats.escalated = timedOut.rows.length;

  return stats;
};

exports.runSweep = async (req, res) => {
  try {
    const stats = await exports.sweepDueProposals(req.app.get('io'));
    return res.status(200).json(stats);
  } catch (err) {
    console.error('Error running resolution sweep:', err);
    return res.status(500).json({ message: 'Failed to run resolution sweep' });
  }
};

// Admin ruling on an escalated proposal. Matching ruling confirms the
// proposal (proposer refunded, confirm voters win); differing ruling
// overturns it (proposer forfeits + cooldown, reject voters win).
exports.adminRuling = async (req, res) => {
  const proposalId = Number(req.params.id);
  const { outcome = null, outcome_id = null } = req.body || {};

  if (!Number.isFinite(proposalId)) {
    return res.status(400).json({ message: 'Invalid proposal id' });
  }
  const outcomeId = Number.isInteger(outcome_id) ? outcome_id : Number.parseInt(outcome_id, 10);
  const hasOutcomeId = Number.isInteger(outcomeId) && outcomeId > 0;
  const hasBinaryOutcome = outcome === 'yes' || outcome === 'no';
  if (hasOutcomeId === hasBinaryOutcome) {
    return res.status(400).json({ message: "Provide exactly one of outcome ('yes'/'no') or outcome_id" });
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const proposalRes = await client.query(
      'SELECT * FROM market_resolution_proposals WHERE id = $1 FOR UPDATE',
      [proposalId]
    );
    if (proposalRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Proposal not found' });
    }
    const proposal = proposalRes.rows[0];
    if (!['escalated', 'voting', 'challenge_window'].includes(proposal.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Proposal already decided (status: ${proposal.status})` });
    }

    await settleEvent(proposal.event_id, {
      outcome: hasBinaryOutcome ? outcome : null,
      outcomeId: hasOutcomeId ? outcomeId : null
    }, req.app.get('io'));

    const matchesProposal = hasBinaryOutcome
      ? proposal.proposed_outcome === outcome
      : Number(proposal.proposed_outcome_id) === outcomeId;

    if (matchesProposal) {
      await refundProposer(client, proposal, { withReward: true });
      await settleVotes(client, proposal.id, 'confirm');
    } else {
      // Proposer stake forfeited (not refunded); reject voters were right.
      await settleVotes(client, proposal.id, 'reject');
    }

    const updated = await client.query(
      `UPDATE market_resolution_proposals
       SET status = $2, proposer_stake_settled = TRUE, decided_at = NOW(),
           admin_ruled_by = $3, admin_outcome = $4, admin_outcome_id = $5, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        proposalId,
        matchesProposal ? 'confirmed' : 'overturned',
        req.user.id,
        hasBinaryOutcome ? outcome : null,
        hasOutcomeId ? outcomeId : null
      ]
    );

    await client.query('COMMIT');
    return res.status(200).json({ proposal: normalizeProposal(updated.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error ruling on resolution proposal:', err);
    return res.status(500).json({ message: 'Failed to rule on proposal' });
  } finally {
    client.release();
  }
};

// Jury queue: open proposals the current user was drawn for and hasn't voted on.
exports.getJuryQueue = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, e.title AS event_title, u.username AS proposer_username
       FROM market_resolution_proposals p
       JOIN market_resolution_jurors j ON j.proposal_id = p.id AND j.user_id = $1
       JOIN events e ON e.id = p.event_id
       JOIN users u ON u.id = p.proposer_user_id
       WHERE p.status = 'voting'
         AND NOT EXISTS (
           SELECT 1 FROM market_resolution_votes v
           WHERE v.proposal_id = p.id AND v.voter_user_id = $1
         )
       ORDER BY p.created_at ASC`,
      [req.user.id]
    );
    return res.json(result.rows.map((row) => ({
      ...normalizeProposal(row),
      event_title: row.event_title,
      proposer_username: row.proposer_username
    })));
  } catch (err) {
    console.error('Error loading jury queue:', err);
    return res.status(500).json({ message: 'Failed to load jury queue' });
  }
};

// Admin: escalated proposals awaiting a ruling.
exports.getEscalations = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, e.title AS event_title, u.username AS proposer_username
       FROM market_resolution_proposals p
       JOIN events e ON e.id = p.event_id
       JOIN users u ON u.id = p.proposer_user_id
       WHERE p.status = 'escalated'
       ORDER BY p.created_at ASC`
    );
    return res.json(result.rows.map((row) => ({
      ...normalizeProposal(row),
      event_title: row.event_title,
      proposer_username: row.proposer_username
    })));
  } catch (err) {
    console.error('Error loading escalations:', err);
    return res.status(500).json({ message: 'Failed to load escalations' });
  }
};

// Active proposal for one event (market detail page).
exports.getEventProposal = async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!Number.isFinite(eventId)) {
    return res.status(400).json({ message: 'Invalid event id' });
  }
  try {
    const result = await db.query(
      `SELECT * FROM market_resolution_proposals
       WHERE event_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [eventId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No resolution proposal for this event' });
    }
    return res.json({ proposal: normalizeProposal(result.rows[0]) });
  } catch (err) {
    console.error('Error loading event proposal:', err);
    return res.status(500).json({ message: 'Failed to load proposal' });
  }
};

exports.getConfig = (req, res) => {
  res.json({
    proposerStakeRp: Number(PROPOSER_STAKE_RP),
    proposerRewardRp: Number(PROPOSER_REWARD_RP),
    voterStakeRp: Number(VOTER_STAKE_RP),
    voterPayoutRp: Number(VOTER_PAYOUT_RP),
    juryDrawCap: JURY_DRAW_CAP,
    confirmsToPass: CONFIRMS_TO_PASS,
    rejectsToEscalate: REJECTS_TO_ESCALATE,
    votingWindowHours: VOTING_WINDOW_HOURS,
    challengeWindowHours: CHALLENGE_WINDOW_HOURS,
    juryActivityDays: JURY_ACTIVITY_DAYS,
    proposerCooldownDays: PROPOSER_COOLDOWN_DAYS
  });
};
