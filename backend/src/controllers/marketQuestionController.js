const db = require('../db');

const LEDGER_SCALE = 1_000_000n;

const BASE_CREATOR_BOND_RP = 10n;
const CREATOR_BOND_STEP_RP = 5n;
const VALIDATOR_STAKE_RP = 2n;
const VALIDATOR_PAYOUT_RP = 5n; // Total returned to winning-side validators (includes stake)
const CREATOR_APPROVAL_REWARD_RP = 10n;
const CREATOR_TRACTION_REWARD_RP = 10n;
const CREATOR_RESOLUTION_REWARD_RP = 10n;
const REQUIRED_VALIDATORS = 5;
const REQUIRED_APPROVALS = 4;
const TRACTION_MIN_BETTORS = 10;
const TRACTION_MIN_STAKE_LEDGER = 100n * LEDGER_SCALE; // 100 RP

const toLedger = (rpBigInt) => (rpBigInt * LEDGER_SCALE);
const fromLedger = (ledgerValue) => Number(ledgerValue) / 1_000_000;
const toLedgerString = (rpBigInt) => toLedger(rpBigInt).toString();

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const parseBool = (value) => value === '1' || value === 'true' || value === true;

const normalizeSubmission = (row) => ({
  ...row,
  creator_bond_rp: fromLedger(row.creator_bond_ledger || 0),
  approvals: Number(row.approvals || 0),
  rejections: Number(row.rejections || 0),
  total_reviews: Number(row.total_reviews || 0),
  required_validators: Number(row.required_validators || REQUIRED_VALIDATORS),
  required_approvals: Number(row.required_approvals || REQUIRED_APPROVALS)
});

const settleCreatorReward = async ({
  client,
  submissionId,
  creatorUserId,
  rewardLedger,
  rewardColumn
}) => {
  const setResult = await client.query(
    `UPDATE market_question_submissions
     SET ${rewardColumn} = TRUE, updated_at = NOW()
     WHERE id = $1 AND ${rewardColumn} = FALSE
     RETURNING id`,
    [submissionId]
  );

  if (setResult.rows.length === 0) {
    return false;
  }

  await client.query(
    'UPDATE users SET rp_balance_ledger = rp_balance_ledger + $1::bigint WHERE id = $2',
    [rewardLedger, creatorUserId]
  );
  return true;
};

exports.getConfig = async (_req, res) => {
  res.json({
    requiredValidators: REQUIRED_VALIDATORS,
    requiredApprovals: REQUIRED_APPROVALS,
    baseCreatorBondRp: Number(BASE_CREATOR_BOND_RP),
    creatorBondStepRp: Number(CREATOR_BOND_STEP_RP),
    validatorStakeRp: Number(VALIDATOR_STAKE_RP),
    validatorPayoutRp: Number(VALIDATOR_PAYOUT_RP),
    creatorRewardsRp: {
      approval: Number(CREATOR_APPROVAL_REWARD_RP),
      traction: Number(CREATOR_TRACTION_REWARD_RP),
      resolution: Number(CREATOR_RESOLUTION_REWARD_RP)
    },
    tractionThreshold: {
      minUniqueBettors: TRACTION_MIN_BETTORS,
      minTotalStakeRp: Number(TRACTION_MIN_STAKE_LEDGER / LEDGER_SCALE)
    }
  });
};

exports.createSubmission = async (req, res) => {
  const creatorUserId = req.user.id;
  const { title, details, category = null, closing_date: closingDate } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ message: 'title is required' });
  }
  if (!details || !String(details).trim()) {
    return res.status(400).json({ message: 'details is required' });
  }
  if (!closingDate) {
    return res.status(400).json({ message: 'closing_date is required' });
  }

  const parsedClosingDate = new Date(closingDate);
  if (Number.isNaN(parsedClosingDate.getTime())) {
    return res.status(400).json({ message: 'closing_date must be a valid ISO date' });
  }
  if (parsedClosingDate <= new Date()) {
    return res.status(400).json({ message: 'closing_date must be in the future' });
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');

    const openCountRes = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM market_question_submissions
       WHERE creator_user_id = $1 AND status = 'pending'`,
      [creatorUserId]
    );
    const openCount = Number(openCountRes.rows[0]?.count || 0);
    const bondRp = BASE_CREATOR_BOND_RP + (CREATOR_BOND_STEP_RP * BigInt(openCount));
    const bondLedger = toLedgerString(bondRp);

    const balanceUpdate = await client.query(
      `UPDATE users
       SET rp_balance_ledger = rp_balance_ledger - $1::bigint
       WHERE id = $2 AND rp_balance_ledger >= $1::bigint
       RETURNING rp_balance_ledger`,
      [bondLedger, creatorUserId]
    );
    if (balanceUpdate.rows.length === 0) {
      throw httpError(400, 'Insufficient RP balance for submission bond');
    }

    const insertRes = await client.query(
      `INSERT INTO market_question_submissions
        (creator_user_id, title, details, category, closing_date, creator_bond_ledger, required_validators, required_approvals)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8)
       RETURNING *`,
      [
        creatorUserId,
        String(title).trim(),
        String(details).trim(),
        category ? String(category).trim() : null,
        parsedClosingDate,
        bondLedger,
        REQUIRED_VALIDATORS,
        REQUIRED_APPROVALS
      ]
    );

    await client.query('COMMIT');

    const submission = normalizeSubmission(insertRes.rows[0]);
    res.status(201).json({
      submission,
      creator_bond_rp: Number(bondRp),
      open_submissions_before_create: openCount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating market question submission:', err);
    res.status(err.status || 500).json({ message: err.message || 'Failed to create submission' });
  } finally {
    client.release();
  }
};

exports.listSubmissions = async (req, res) => {
  const userId = req.user.id;
  const status = req.query.status ? String(req.query.status).toLowerCase() : null;
  const mineOnly = parseBool(req.query.mine);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

  if (status && !['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'status must be one of pending, approved, rejected' });
  }

  try {
    const params = [userId, limit, offset];
    let where = 'WHERE 1=1';

    if (status) {
      params.push(status);
      where += ` AND mqs.status = $${params.length}`;
    }
    if (mineOnly) {
      where += ' AND mqs.creator_user_id = $1';
    }

    const result = await db.query(
      `SELECT
         mqs.*,
         u.username AS creator_username,
         EXISTS (
           SELECT 1
           FROM market_question_reviews r
           WHERE r.submission_id = mqs.id AND r.reviewer_user_id = $1
         ) AS reviewed_by_me
       FROM market_question_submissions mqs
       JOIN users u ON u.id = mqs.creator_user_id
       ${where}
       ORDER BY mqs.created_at DESC
       LIMIT $2 OFFSET $3`
      ,
      params
    );

    res.json(result.rows.map(normalizeSubmission));
  } catch (err) {
    console.error('Error listing market question submissions:', err);
    res.status(500).json({ message: 'Failed to list submissions' });
  }
};

exports.getReviewQueue = async (req, res) => {
  const reviewerUserId = req.user.id;
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);

  try {
    const result = await db.query(
      `SELECT
         mqs.*,
         u.username AS creator_username
       FROM market_question_submissions mqs
       JOIN users u ON u.id = mqs.creator_user_id
       WHERE mqs.status = 'pending'
         AND mqs.total_reviews < mqs.required_validators
         AND mqs.creator_user_id <> $1
         AND NOT EXISTS (
           SELECT 1
           FROM market_question_reviews r
           WHERE r.submission_id = mqs.id AND r.reviewer_user_id = $1
         )
       ORDER BY mqs.created_at ASC
       LIMIT $2`,
      [reviewerUserId, limit]
    );

    res.json(result.rows.map(normalizeSubmission));
  } catch (err) {
    console.error('Error loading review queue:', err);
    res.status(500).json({ message: 'Failed to load review queue' });
  }
};

exports.submitReview = async (req, res) => {
  const reviewerUserId = req.user.id;
  const submissionId = Number(req.params.id);
  const { vote, note = null } = req.body || {};

  if (!Number.isFinite(submissionId)) {
    return res.status(400).json({ message: 'Invalid submission id' });
  }
  if (!['approve', 'reject'].includes(vote)) {
    return res.status(400).json({ message: "vote must be 'approve' or 'reject'" });
  }

  const validatorStakeLedger = toLedgerString(VALIDATOR_STAKE_RP);
  const validatorPayoutLedger = toLedgerString(VALIDATOR_PAYOUT_RP);
  const creatorApprovalRewardLedger = toLedgerString(CREATOR_APPROVAL_REWARD_RP);

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');

    const submissionRes = await client.query(
      'SELECT * FROM market_question_submissions WHERE id = $1 FOR UPDATE',
      [submissionId]
    );
    if (submissionRes.rows.length === 0) {
      throw httpError(404, 'Submission not found');
    }
    const submission = submissionRes.rows[0];

    if (submission.status !== 'pending') {
      throw httpError(409, `Submission is already ${submission.status}`);
    }
    if (Number(submission.creator_user_id) === reviewerUserId) {
      throw httpError(403, 'Creator cannot review their own submission');
    }

    const alreadyReviewedRes = await client.query(
      'SELECT 1 FROM market_question_reviews WHERE submission_id = $1 AND reviewer_user_id = $2',
      [submissionId, reviewerUserId]
    );
    if (alreadyReviewedRes.rows.length > 0) {
      throw httpError(409, 'You have already reviewed this submission');
    }

    if (Number(submission.total_reviews || 0) >= Number(submission.required_validators || REQUIRED_VALIDATORS)) {
      throw httpError(409, 'Submission already has enough reviews');
    }

    const reviewerBalanceRes = await client.query(
      `UPDATE users
       SET rp_balance_ledger = rp_balance_ledger - $1::bigint
       WHERE id = $2 AND rp_balance_ledger >= $1::bigint
       RETURNING rp_balance_ledger`,
      [validatorStakeLedger, reviewerUserId]
    );
    if (reviewerBalanceRes.rows.length === 0) {
      throw httpError(400, 'Insufficient RP balance for validator stake');
    }

    await client.query(
      `INSERT INTO market_question_reviews
        (submission_id, reviewer_user_id, vote, note, stake_ledger)
       VALUES ($1, $2, $3, $4, $5::bigint)`,
      [submissionId, reviewerUserId, vote, note ? String(note).trim() : null, validatorStakeLedger]
    );

    const tallyRes = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE vote = 'approve')::int AS approvals,
         COUNT(*) FILTER (WHERE vote = 'reject')::int AS rejections
       FROM market_question_reviews
       WHERE submission_id = $1`,
      [submissionId]
    );
    const tally = tallyRes.rows[0];
    const totalReviews = Number(tally.total || 0);
    const approvals = Number(tally.approvals || 0);
    const rejections = Number(tally.rejections || 0);

    const requiredValidators = Number(submission.required_validators || REQUIRED_VALIDATORS);
    const requiredApprovals = Number(submission.required_approvals || REQUIRED_APPROVALS);

    if (totalReviews < requiredValidators) {
      const pendingUpdateRes = await client.query(
        `UPDATE market_question_submissions
         SET total_reviews = $2,
             approvals = $3,
             rejections = $4,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [submissionId, totalReviews, approvals, rejections]
      );

      await client.query('COMMIT');
      return res.json({
        finalized: false,
        submission: normalizeSubmission(pendingUpdateRes.rows[0])
      });
    }

    const approved = approvals >= requiredApprovals;
    const finalStatus = approved ? 'approved' : 'rejected';
    const winningVote = approved ? 'approve' : 'reject';
    let approvedEventId = null;

    if (approved) {
      const eventRes = await client.query(
        `INSERT INTO events (title, details, closing_date, category)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [submission.title, submission.details, submission.closing_date, submission.category]
      );
      approvedEventId = eventRes.rows[0].id;

      const creatorApprovalPayoutLedger = (
        BigInt(submission.creator_bond_ledger || 0) + toLedger(CREATOR_APPROVAL_REWARD_RP)
      ).toString();

      await client.query(
        `UPDATE users
         SET rp_balance_ledger = rp_balance_ledger + $1::bigint
         WHERE id = $2`,
        [creatorApprovalPayoutLedger, submission.creator_user_id]
      );
    }

    await client.query(
      `UPDATE market_question_reviews
       SET payout_ledger = CASE WHEN vote = $2 THEN $3::bigint ELSE 0 END,
           settled_at = NOW()
       WHERE submission_id = $1`,
      [submissionId, winningVote, validatorPayoutLedger]
    );

    await client.query(
      `UPDATE users
       SET rp_balance_ledger = rp_balance_ledger + $2::bigint
       WHERE id IN (
         SELECT reviewer_user_id
         FROM market_question_reviews
         WHERE submission_id = $1 AND vote = $3
       )`,
      [submissionId, validatorPayoutLedger, winningVote]
    );

    const finalizedRes = await client.query(
      `UPDATE market_question_submissions
       SET status = $2,
           total_reviews = $3,
           approvals = $4,
           rejections = $5,
           approved_event_id = $6,
           creator_approval_reward_paid = $7,
           finalized_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [submissionId, finalStatus, totalReviews, approvals, rejections, approvedEventId, approved]
    );

    await client.query('COMMIT');
    return res.json({
      finalized: true,
      approved,
      approved_event_id: approvedEventId,
      submission: normalizeSubmission(finalizedRes.rows[0]),
      payouts: {
        creator_approval_reward_rp: approved ? Number(CREATOR_APPROVAL_REWARD_RP) : 0,
        validator_payout_rp: Number(VALIDATOR_PAYOUT_RP),
        validator_stake_rp: Number(VALIDATOR_STAKE_RP)
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error submitting market question review:', err);
    res.status(err.status || 500).json({ message: err.message || 'Failed to submit review' });
  } finally {
    client.release();
  }
};

exports.getSubmission = async (req, res) => {
  const submissionId = Number(req.params.id);
  if (!Number.isFinite(submissionId)) {
    return res.status(400).json({ message: 'Invalid submission id' });
  }

  try {
    const submissionRes = await db.query(
      `SELECT mqs.*, u.username AS creator_username
       FROM market_question_submissions mqs
       JOIN users u ON u.id = mqs.creator_user_id
       WHERE mqs.id = $1`,
      [submissionId]
    );
    if (submissionRes.rows.length === 0) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const reviewsRes = await db.query(
      `SELECT
         r.id,
         r.reviewer_user_id,
         u.username AS reviewer_username,
         r.vote,
         r.note,
         r.stake_ledger,
         r.payout_ledger,
         r.settled_at,
         r.created_at
       FROM market_question_reviews r
       JOIN users u ON u.id = r.reviewer_user_id
       WHERE r.submission_id = $1
       ORDER BY r.created_at ASC`,
      [submissionId]
    );

    const reviews = reviewsRes.rows.map((row) => ({
      ...row,
      stake_rp: fromLedger(row.stake_ledger || 0),
      payout_rp: fromLedger(row.payout_ledger || 0)
    }));

    res.json({
      submission: normalizeSubmission(submissionRes.rows[0]),
      reviews
    });
  } catch (err) {
    console.error('Error getting market question submission:', err);
    res.status(500).json({ message: 'Failed to fetch submission' });
  }
};

exports.rewardTraction = async (req, res) => {
  const submissionId = Number(req.params.id);
  if (!Number.isFinite(submissionId)) {
    return res.status(400).json({ message: 'Invalid submission id' });
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');

    const submissionRes = await client.query(
      'SELECT * FROM market_question_submissions WHERE id = $1 FOR UPDATE',
      [submissionId]
    );
    if (submissionRes.rows.length === 0) throw httpError(404, 'Submission not found');
    const submission = submissionRes.rows[0];

    if (submission.status !== 'approved') {
      throw httpError(409, 'Traction reward only applies to approved submissions');
    }
    if (!submission.approved_event_id) {
      throw httpError(409, 'Approved submission has no linked event');
    }
    if (submission.creator_traction_reward_paid) {
      await client.query('COMMIT');
      return res.json({ success: true, alreadyPaid: true });
    }

    const metricsRes = await client.query(
      `SELECT
         COUNT(DISTINCT user_id)::int AS bettors,
         COALESCE(SUM(COALESCE(stake_amount_ledger, ROUND(stake_amount * 1000000)::bigint)), 0)::bigint AS total_stake_ledger
       FROM market_updates
       WHERE event_id = $1`,
      [submission.approved_event_id]
    );
    const bettors = Number(metricsRes.rows[0]?.bettors || 0);
    const totalStakeLedger = BigInt(metricsRes.rows[0]?.total_stake_ledger || 0);
    const thresholdMet = bettors >= TRACTION_MIN_BETTORS || totalStakeLedger >= TRACTION_MIN_STAKE_LEDGER;
    if (!thresholdMet) {
      throw httpError(
        409,
        `Traction threshold not met (need ${TRACTION_MIN_BETTORS}+ bettors or ${Number(TRACTION_MIN_STAKE_LEDGER / LEDGER_SCALE)} RP stake)`
      );
    }

    const rewarded = await settleCreatorReward({
      client,
      submissionId,
      creatorUserId: submission.creator_user_id,
      rewardLedger: toLedgerString(CREATOR_TRACTION_REWARD_RP),
      rewardColumn: 'creator_traction_reward_paid'
    });

    await client.query('COMMIT');
    res.json({
      success: true,
      rewarded,
      traction: {
        bettors,
        total_stake_rp: fromLedger(totalStakeLedger)
      },
      reward_rp: Number(CREATOR_TRACTION_REWARD_RP)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error applying traction reward:', err);
    res.status(err.status || 500).json({ message: err.message || 'Failed to apply traction reward' });
  } finally {
    client.release();
  }
};

exports.rewardResolution = async (req, res) => {
  const submissionId = Number(req.params.id);
  if (!Number.isFinite(submissionId)) {
    return res.status(400).json({ message: 'Invalid submission id' });
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');

    const submissionRes = await client.query(
      'SELECT * FROM market_question_submissions WHERE id = $1 FOR UPDATE',
      [submissionId]
    );
    if (submissionRes.rows.length === 0) throw httpError(404, 'Submission not found');
    const submission = submissionRes.rows[0];

    if (submission.status !== 'approved') {
      throw httpError(409, 'Resolution reward only applies to approved submissions');
    }
    if (!submission.approved_event_id) {
      throw httpError(409, 'Approved submission has no linked event');
    }
    if (submission.creator_resolution_reward_paid) {
      await client.query('COMMIT');
      return res.json({ success: true, alreadyPaid: true });
    }

    const eventRes = await client.query(
      'SELECT outcome FROM events WHERE id = $1',
      [submission.approved_event_id]
    );
    if (eventRes.rows.length === 0) {
      throw httpError(404, 'Linked event not found');
    }
    if (!eventRes.rows[0].outcome) {
      throw httpError(409, 'Linked event is not resolved yet');
    }

    const rewarded = await settleCreatorReward({
      client,
      submissionId,
      creatorUserId: submission.creator_user_id,
      rewardLedger: toLedgerString(CREATOR_RESOLUTION_REWARD_RP),
      rewardColumn: 'creator_resolution_reward_paid'
    });

    await client.query('COMMIT');
    res.json({
      success: true,
      rewarded,
      reward_rp: Number(CREATOR_RESOLUTION_REWARD_RP)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error applying resolution reward:', err);
    res.status(err.status || 500).json({ message: err.message || 'Failed to apply resolution reward' });
  } finally {
    client.release();
  }
};
