// Refund staked RP still held against a set of events BEFORE deleting the
// event rows. Event deletion cascades user_shares / user_outcome_shares /
// numeric_position_basis but does NOT unwind users.rp_staked_ledger, so a
// bare DELETE permanently leaks staked RP on shared test accounts.
// `psql` is the calling spec's own SQL runner; `ids` a comma-joined id list.
const refundEventStakes = (psql, ids) => {
  if (!ids) return;
  psql(`UPDATE users u
        SET rp_balance_ledger = rp_balance_ledger + s.total,
            rp_staked_ledger = rp_staked_ledger - s.total
        FROM (SELECT user_id, SUM(staked_yes_ledger + staked_no_ledger) AS total
              FROM user_shares WHERE event_id IN (${ids}) GROUP BY user_id) s
        WHERE s.user_id = u.id AND s.total > 0`);
  psql(`UPDATE users u
        SET rp_balance_ledger = rp_balance_ledger + s.total,
            rp_staked_ledger = rp_staked_ledger - s.total
        FROM (SELECT user_id, SUM(staked_ledger) AS total
              FROM user_outcome_shares WHERE event_id IN (${ids}) GROUP BY user_id) s
        WHERE s.user_id = u.id AND s.total > 0`);
  psql(`UPDATE users u
        SET rp_balance_ledger = rp_balance_ledger + b.total,
            rp_staked_ledger = rp_staked_ledger - b.total
        FROM (SELECT user_id, SUM(basis_ledger) AS total
              FROM numeric_position_basis WHERE event_id IN (${ids}) GROUP BY user_id) b
        WHERE b.user_id = u.id AND b.total > 0`);
};

module.exports = { refundEventStakes };
