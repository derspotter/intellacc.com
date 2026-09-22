// Initial conservative routing thresholds, not calibrated accuracy estimates.
const primaryEnabled = () => process.env.POST_SIGNAL_JEV_MODE === 'primary';
const decide = (result, candidates) => {
  const fallback = (reason) => ({ accepted: false, reason });
  if (result?.status !== 'ok') return fallback(result?.error_code || 'unavailable');
  const answers = result.answers;
  const claim = answers?.has_claim?.noul;
  if (!Number.isFinite(claim)) return fallback('invalid_claim');
  if (!candidates.length) {
    // With no retrieved candidates there is no safe link to create, regardless
    // of whether the text contains a claim. Retain uncertain cases for the LLM.
    if (claim > 0.1) return fallback('no_candidates');
    return { accepted: true, hasClaim: false, bestMarket: null };
  }
  const best = answers?.best_market;
  if (!(best?.confidence >= 0.85) || !(best.probabilities?.[best.choice] >= 0.85)) return fallback('uncertain_market');
  if (best.choice === 'none') {
    // A missing market is distinct from a missing claim.
    if (claim > 0.1 && claim < 0.8) return fallback('uncertain_claim');
    return { accepted: true, hasClaim: claim >= 0.8, bestMarket: null };
  }
  const candidate = candidates.find((c) => `market_${c.event_id}` === best.choice);
  if (!candidate) return fallback('unknown_market');
  const relevance = answers[`relevant_${candidate.event_id}`]?.noul;
  const stance = answers[`stance_${candidate.event_id}`];
  if (claim < 0.8 || !Number.isFinite(relevance) || relevance < 0.8) return fallback('uncertain_relevance');
  if (!stance || !['agrees', 'disagrees', 'related'].includes(stance.choice)
      || !(stance.confidence >= 0.85) || !(stance.probabilities?.[stance.choice] >= 0.85)) return fallback('uncertain_stance');
  return { accepted: true, hasClaim: true, bestMarket: {
    event_id: Number(candidate.event_id), stance: stance.choice,
    confidence: Math.min(best.confidence, best.probabilities[best.choice], relevance,
      stance.confidence, stance.probabilities[stance.choice]),
    reasoning: 'Jev matched the post to this market and classified its stance.'
  } };
};
module.exports = { primaryEnabled, decide };
