const db = require('../db');

/**
 * Settle a market through the prediction engine and mirror the result onto
 * the events row. Shared by admin resolveEvent and the community resolution
 * flow. Exactly one of outcome ('yes'/'no'), outcomeId, numericalOutcome
 * must be provided. Throws { status, body } on engine refusal.
 */
async function settleEvent(eventId, { outcome = null, outcomeId = null, numericalOutcome = null }, io = null) {
  const hasOutcomeId = Number.isInteger(outcomeId) && outcomeId > 0;
  const hasNumericalOutcome = Number.isFinite(numericalOutcome);
  const resolvedBoolean = outcome === 'yes';

  const engineBody = hasOutcomeId
    ? { outcome_id: outcomeId }
    : (hasNumericalOutcome ? { numerical_outcome: numericalOutcome } : { outcome: resolvedBoolean });

  const response = await fetch(`http://prediction-engine:3001/events/${eventId}/market-resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.PREDICTION_ENGINE_AUTH_TOKEN ? { 'x-engine-token': process.env.PREDICTION_ENGINE_AUTH_TOKEN } : {})
    },
    body: JSON.stringify(engineBody)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(result.message || `Engine refused resolution for event ${eventId}`);
    err.status = response.status;
    err.body = result;
    throw err;
  }

  const backendOutcome = hasOutcomeId
    ? `resolved_outcome_${outcomeId}`
    : (hasNumericalOutcome ? 'resolved_numeric' : outcome);
  const backendNumericalOutcome = hasNumericalOutcome
    ? numericalOutcome
    : (hasOutcomeId ? null : (resolvedBoolean ? 1 : 0));
  const resolvedOutcomeId = hasOutcomeId
    ? outcomeId
    : (Number.isInteger(result.outcome_id) ? result.outcome_id : null);

  const update = await db.query(
    `UPDATE events
     SET outcome = $1,
         numerical_outcome = $2,
         resolution_outcome_id = $3,
         resolved_at = COALESCE(resolved_at, NOW()),
         updated_at = NOW()
     WHERE id = $4
     RETURNING id, title, outcome, numerical_outcome, resolution_outcome_id, closing_date`,
    [backendOutcome, backendNumericalOutcome, resolvedOutcomeId, eventId]
  );

  if (io) {
    io.to('predictions').emit('marketResolved', {
      eventId,
      outcome: backendOutcome,
      outcome_id: resolvedOutcomeId,
      numerical_outcome: backendNumericalOutcome,
      timestamp: new Date().toISOString()
    });
  }

  return { event: update.rows[0], engineResult: result };
}

module.exports = { settleEvent };
