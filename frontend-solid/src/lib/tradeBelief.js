// Belief-driven trade direction. The trader states P(YES); the side is a
// consequence, never an independent choice. Within TRADE_EPS of the market
// price there is no edge to trade on, so no side is derived.
export const TRADE_EPS = 0.005;

export const deriveTradeSide = (belief, marketProb, eps = TRADE_EPS) => {
  const b = Number(belief);
  const p = Number(marketProb);
  if (!Number.isFinite(b) || !Number.isFinite(p)) return null;
  const diff = b - p;
  if (Math.abs(diff) < eps) return null;
  return diff > 0 ? 'yes' : 'no';
};
