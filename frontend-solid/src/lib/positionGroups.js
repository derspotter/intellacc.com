/**
 * Group a user's position rows (GET /users/:id/positions) into one entry per
 * market. Shared by the positions tab and both profile pages, so "your
 * predictions" on a profile are the same LMSR positions the trading UI shows
 * — not the legacy `predictions` table, which trading no longer writes.
 */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const rowsOf = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.positions)) return payload.positions;
  return [];
};

export const groupPositions = (payload) => {
  const byId = new Map();
  for (const row of rowsOf(payload)) {
    const key = String(row.event_id);
    if (!byId.has(key)) {
      byId.set(key, {
        event: {
          id: row.event_id,
          title: row.event_title,
          closing_date: row.closing_date,
          market_prob: row.market_prob,
          cumulative_stake: row.cumulative_stake,
          liquidity_b: row.liquidity_b,
          event_type: row.event_type,
          outcome: row.outcome
        },
        kind: row.position_kind === 'resolved' ? 'resolved' : 'open',
        hidden: !!row.hidden_at,
        resolvedAt: row.resolved_at,
        resolutionLabel: row.resolution_outcome_label,
        outcomes: [],
        numericBins: 0,
        numericShares: 0
      });
    }
    const group = byId.get(key);
    if (group.event.event_type === 'numeric') {
      if (row.outcome_label && num(row.outcome_shares) > 0) {
        group.numericBins += 1;
        group.numericShares += num(row.outcome_shares);
      }
    } else {
      if (row.outcome_label && num(row.outcome_shares) > 0) {
        group.outcomes.push({ label: row.outcome_label, shares: num(row.outcome_shares) });
      }
      if (num(row.yes_shares) > 0) group.outcomes.push({ label: 'YES', shares: num(row.yes_shares) });
      if (num(row.no_shares) > 0) group.outcomes.push({ label: 'NO', shares: num(row.no_shares) });
    }
  }
  const groups = [...byId.values()];
  const open = groups
    .filter((g) => g.kind === 'open')
    .sort((a, b) => new Date(a.event.closing_date) - new Date(b.event.closing_date));
  const resolved = groups
    .filter((g) => g.kind === 'resolved')
    .sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
  return { byId, open, resolved, all: [...open, ...resolved] };
};

/** "YES ×12.0 · NO ×3.0" or "Distribution · 4 bins · 10.0 sh". */
export const summarizeHoldings = (group) => {
  if (!group) return '';
  if (group.numericBins > 0) {
    const bins = group.numericBins === 1 ? '1 bin' : `${group.numericBins} bins`;
    return `Distribution · ${bins} · ${group.numericShares.toFixed(1)} sh`;
  }
  return group.outcomes.map((o) => `${o.label} ×${o.shares.toFixed(1)}`).join(' · ');
};

/** Resolution label for settled markets, otherwise "Open". */
export const positionStatus = (group) => {
  if (!group) return '';
  if (group.kind !== 'resolved') return 'Open';
  if (group.resolutionLabel) return group.resolutionLabel;
  const raw = String(group.event?.outcome || '').toLowerCase();
  if (raw.includes('yes')) return 'YES';
  if (raw.includes('no')) return 'NO';
  return 'Resolved';
};
