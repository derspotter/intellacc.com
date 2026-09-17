// Belief-driven trade direction. The trader states P(YES); the side is a
// consequence, never an independent choice. Within TRADE_EPS of the market
// price there is no edge to trade on, so no side is derived.
export const TRADE_EPS = 0.005;

// Pointer slider movements snap. Typed percentages stay exact.
export const snapBeliefToMarket = (belief, marketProb) => {
  const market = Number(marketProb);
  return market >= 0.01 && market <= 0.99 && Math.abs(belief - market) <= 0.01 + Number.EPSILON
    ? market
    : belief;
};

export const parseBeliefPercent = (text) => {
  if (String(text).trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 1 && value <= 99 ? value / 100 : null;
};

export const formatBeliefPercent = (belief, marketProb) =>
  belief === marketProb ? (belief * 100).toFixed(1) : String(Number((belief * 100).toFixed(4)));

export const deriveTradeSide = (belief, marketProb, eps = TRADE_EPS) => {
  const b = Number(belief);
  const p = Number(marketProb);
  if (!Number.isFinite(b) || !Number.isFinite(p)) return null;
  const diff = b - p;
  if (Math.abs(diff) < eps) return null;
  return diff > 0 ? 'yes' : 'no';
};
