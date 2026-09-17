// Eligibility rules shared by the two halves of community market resolution:
// the jury draw / proposal guard in marketResolutionController, and the random
// proposer assignment draw in resolutionAssignmentService. Both must exclude
// the same people, so the predicates and the economics they key off live here.

const LEDGER_SCALE = 1_000_000n;

// Resolution moves real market payouts, so its stakes sit far above the
// 10 RP question-creation bond: propose at 50, judge at 10.
const PROPOSER_STAKE_RP = 50n;
// A proposer whose proposal was overturned cannot propose again this soon —
// and is therefore not worth assigning a market to either.
const PROPOSER_COOLDOWN_DAYS = 7;
// "Recently active" for both jury duty and proposer assignment.
const ACTIVITY_DAYS = 7;

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

// True while the user is serving a post-overturn proposer cooldown.
const proposerCooldownSql = (userParam, daysParam) => `EXISTS (
  SELECT 1 FROM market_resolution_proposals cd
  WHERE cd.proposer_user_id = ${userParam}
    AND cd.status = 'overturned'
    AND cd.decided_at > NOW() - (${daysParam} || ' days')::interval
)`;

module.exports = {
  LEDGER_SCALE,
  PROPOSER_STAKE_RP,
  PROPOSER_COOLDOWN_DAYS,
  ACTIVITY_DAYS,
  toLedgerString,
  involvementSql,
  isUserInvolved,
  proposerCooldownSql
};
