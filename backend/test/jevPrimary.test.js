const { decide } = require('../src/services/openRouterMatcher/jevPrimary');
const candidates = [{ event_id: 42 }];
const result = () => ({ status: 'ok', answers: {
  has_claim: { noul: 0.99 },
  best_market: { choice: 'market_42', confidence: 0.95, probabilities: { market_42: 0.96, none: 0.04 } },
  relevant_42: { noul: 0.95 },
  stance_42: { choice: 'disagrees', confidence: 0.98, probabilities: { agrees: 0.01, disagrees: 0.98, related: 0.01 } }
} });
test('high-confidence negative stance is accepted', () => {
  expect(decide(result(), candidates)).toMatchObject({ accepted: true, hasClaim: true,
    bestMarket: { event_id: 42, stance: 'disagrees', confidence: 0.95 } });
});
test.each([
  (r) => { r.status = 'error'; },
  (r) => { r.answers.has_claim.noul = 0.6; },
  (r) => { r.answers.best_market.confidence = 0.6; },
  (r) => { r.answers.best_market.probabilities.market_42 = 0.6; },
  (r) => { r.answers.relevant_42.noul = 0.5; },
  (r) => { r.answers.stance_42.confidence = 0.6; },
  (r) => { delete r.answers.stance_42.probabilities; },
  (r) => { r.answers.best_market.choice = 'market_999'; }
])('uncertain, inconsistent or unavailable decisions use fallback %#', (change) => {
  const r = result(); change(r);
  expect(decide(r, candidates).accepted).toBe(false);
});
test('confident no-market is distinct from no-claim', () => {
  const r = result();
  r.answers.best_market = { choice: 'none', confidence: 0.98, probabilities: { none: 0.99, market_42: 0.01 } };
  expect(decide(r, candidates)).toEqual({ accepted: true, hasClaim: true, bestMarket: null });
  r.answers.has_claim.noul = 0.01;
  expect(decide(r, candidates)).toEqual({ accepted: true, hasClaim: false, bestMarket: null });
});
test('no retrieved candidates still sends predictive claims through fallback', () => {
  expect(decide(result(), []).accepted).toBe(false);
  const r = result(); r.answers.has_claim.noul = 0.01;
  expect(decide(r, [])).toEqual({ accepted: true, hasClaim: false, bestMarket: null });
});
