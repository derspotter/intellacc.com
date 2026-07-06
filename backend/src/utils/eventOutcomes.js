// Shared helpers for multi-outcome (multiple_choice / numeric bucket) events.
// Used by direct event creation and the market-question submission pipeline.

const ALLOWED_EVENT_TYPES = new Set(['binary', 'multiple_choice', 'numeric', 'discrete', 'date']);

const normalizeEventType = (raw) => {
  const value = String(raw || 'binary').trim().toLowerCase();
  return ALLOWED_EVENT_TYPES.has(value) ? value : 'binary';
};

const ensureUniqueOutcomeKeys = (rows) => {
  const seen = new Map();
  return rows.map((row, idx) => {
    const fallbackKey = `choice_${idx + 1}`;
    const baseKey = String(row?.key || fallbackKey).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || fallbackKey;
    const count = seen.get(baseKey) || 0;
    seen.set(baseKey, count + 1);
    return {
      ...row,
      key: count === 0 ? baseKey : `${baseKey}_${count + 1}`
    };
  });
};

const normalizeOutcomeRows = (eventType, outcomes, numericBuckets) => {
  if (eventType === 'multiple_choice') {
    if (!Array.isArray(outcomes)) return [];
    return ensureUniqueOutcomeKeys(outcomes
      .map((item, idx) => {
        if (typeof item === 'string') {
          const label = item.trim();
          if (!label) return null;
          return {
            key: `choice_${idx + 1}`,
            label,
            sortOrder: idx,
            lowerBound: null,
            upperBound: null
          };
        }
        if (!item || typeof item !== 'object') return null;
        const label = String(item.label || '').trim();
        if (!label) return null;
        const key = String(item.key || `choice_${idx + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        return {
          key: key || `choice_${idx + 1}`,
          label,
          sortOrder: Number.isInteger(item.sort_order) ? item.sort_order : idx,
          lowerBound: null,
          upperBound: null
        };
      })
      .filter(Boolean));
  }

  if (eventType === 'numeric') {
    if (!Array.isArray(numericBuckets)) return [];
    return ensureUniqueOutcomeKeys(numericBuckets
      .map((bucket, idx) => {
        if (!bucket || typeof bucket !== 'object') return null;
        const lower = Number(bucket.lower_bound);
        const upper = Number(bucket.upper_bound);
        if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
          return null;
        }
        const label = String(bucket.label || `${lower} to ${upper}`).trim();
        return {
          key: String(bucket.key || `bucket_${idx + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || `bucket_${idx + 1}`,
          label,
          sortOrder: Number.isInteger(bucket.sort_order) ? bucket.sort_order : idx,
          lowerBound: lower,
          upperBound: upper
        };
      })
      .filter(Boolean));
  }

  return [];
};

const validateNumericBuckets = (rows) => {
  const sorted = [...rows].sort((a, b) => a.lowerBound - b.lowerBound || a.upperBound - b.upperBound);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].lowerBound < sorted[i - 1].upperBound) {
      return false;
    }
  }
  return true;
};

const seedEventOutcomes = async (client, eventId, eventType, outcomeRows) => {
  if (!Array.isArray(outcomeRows) || outcomeRows.length < 2) {
    return;
  }

  const prob = 1 / outcomeRows.length;

  const values = [];
  const placeholders = [];
  let paramIdx = 1;

  for (const row of outcomeRows) {
    values.push(eventId, row.key, row.label, row.sortOrder, row.lowerBound, row.upperBound);
    placeholders.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
  }

  // 1. Bulk insert event_outcomes
  const outcomeResult = await client.query(
    `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (event_id, outcome_key) DO UPDATE
     SET label = EXCLUDED.label,
         sort_order = EXCLUDED.sort_order,
         lower_bound = EXCLUDED.lower_bound,
         upper_bound = EXCLUDED.upper_bound,
         updated_at = NOW()
     RETURNING id`,
    values
  );

  // 2. Bulk insert event_outcome_states
  const statesValues = [];
  const statesPlaceholders = [];
  let statesParamIdx = 1;

  for (const row of outcomeResult.rows) {
    statesValues.push(eventId, row.id, 0.0, prob);
    statesPlaceholders.push(`($${statesParamIdx++}, $${statesParamIdx++}, $${statesParamIdx++}, $${statesParamIdx++})`);
  }

  await client.query(
    `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
     VALUES ${statesPlaceholders.join(', ')}
     ON CONFLICT (event_id, outcome_id) DO UPDATE
     SET q_value = EXCLUDED.q_value,
         prob = EXCLUDED.prob,
         updated_at = NOW()`,
    statesValues
  );

  if (eventType === 'multiple_choice' || eventType === 'numeric') {
    const primaryProb = prob;
    await client.query(
      `UPDATE events
       SET market_prob = $1,
           q_yes = 0.0,
           q_no = 0.0
       WHERE id = $2`,
      [primaryProb, eventId]
    );
  }
};

module.exports = {
  ALLOWED_EVENT_TYPES,
  normalizeEventType,
  ensureUniqueOutcomeKeys,
  normalizeOutcomeRows,
  validateNumericBuckets,
  seedEventOutcomes
};
