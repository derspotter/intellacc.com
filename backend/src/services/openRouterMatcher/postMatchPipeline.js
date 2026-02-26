const db = require('../../db');
const config = require('./config');
const { runSafeGate } = require('./claimGate');
const { retrieveCandidateMarkets } = require('./marketRetrieval');
const { runSafeReasoner } = require('./argumentExtractor');

const MAX_ERROR_MESSAGE_LENGTH = 400;
const MATCH_METHOD_DEFAULT = 'hybrid_v1';
const REQUIRED_TABLES = [
  'post_analysis',
  'post_market_matches'
];
const REASONING_TABLES = [
  'post_market_links',
  'propositions',
  'prop_relations',
  'conditional_flags',
  'post_critiques',
  'verification_actions'
];
const RUN_LOG_TABLE = 'post_match_pipeline_runs';

let schemaCapabilityCache = null;

const toPostId = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const clampError = (error) => {
  const message = error?.message || String(error || 'unknown');
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

const normalizeErrorClass = (error) => {
  if (error?.code) {
    return String(error.code);
  }

  return error?.name || 'Error';
};

const logPipelineRun = async ({
  postId,
  status,
  candidateCount = 0,
  durationMs = null,
  processingErrors = null,
  error,
  reasonerAttempted = false,
  reasonerMatch = false
}) => {
  try {
    await db.query(
      `INSERT INTO ${RUN_LOG_TABLE} (
         post_id, status, candidate_count, duration_ms, processing_errors,
         error_class, gate_enabled, reasoner_enabled, reasoner_attempted, reasoner_match
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        postId,
        status,
        candidateCount,
        durationMs,
        processingErrors,
        normalizeErrorClass(error),
        config.isEnabled,
        config.reasoner.enabled,
        reasonerAttempted,
        reasonerMatch
      ]
    );
  } catch (logError) {
    if (logError?.code === '42P01') {
      return;
    }

    console.error('[PostMatchPipeline] Failed to write run log:', logError.message || logError);
  }
};

const logPipelineResult = async ({
  postId,
  status,
  candidateCount,
  durationMs,
  processingErrors,
  reasonerAttempted = false,
  reasonerMatch = false
}) => {
  await logPipelineRun({
    postId,
    status,
    candidateCount,
    durationMs,
    processingErrors,
    reasonerAttempted,
    reasonerMatch
  });
};

const loadPipelineCapabilities = async () => {
  if (schemaCapabilityCache) {
    return schemaCapabilityCache;
  }

  const tableRows = await db.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
  `, [REQUIRED_TABLES.concat(REASONING_TABLES)]);

  const tables = new Set(tableRows.rows.map((row) => row.table_name));

  const capabilityFlags = {
    hasPostAnalysis: tables.has('post_analysis'),
    hasPostMarketMatches: tables.has('post_market_matches'),
    hasReasoningTables: REASONING_TABLES.every((name) => tables.has(name)),
    reasoningTables: {
      postMarketLinks: tables.has('post_market_links'),
      propositions: tables.has('propositions'),
      propRelations: tables.has('prop_relations'),
      conditionalFlags: tables.has('conditional_flags'),
      postCritiques: tables.has('post_critiques'),
      verificationActions: tables.has('verification_actions')
    }
  };

  schemaCapabilityCache = capabilityFlags;
  return capabilityFlags;
};

const canRunPipeline = (capabilities) =>
  capabilities.hasPostAnalysis && capabilities.hasPostMarketMatches;

const canPersistReasoning = (capabilities) => capabilities.hasReasoningTables;

const normalizeCandidates = (candidates) => {
  const seen = new Set();
  const normalized = [];

  for (const candidate of candidates || []) {
    const eventId = Number(candidate?.event_id);
    if (!Number.isInteger(eventId)) continue;
    if (seen.has(eventId)) continue;
    seen.add(eventId);

    normalized.push({
      event_id: eventId,
      match_score: Number(candidate?.match_score) || 0,
      match_method: String(candidate?.match_method || '').trim() || MATCH_METHOD_DEFAULT
    });
  }

  return normalized;
};

const normalizeResultError = (error, fallback = 'processing error') => {
  const message = error?.message || String(error || '').trim() || fallback;
  return `analysis_error=${message}`.slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

const mapCandidatesByEventId = (candidates) => {
  const map = new Map();

  for (const candidate of normalizeCandidates(candidates || [])) {
    map.set(candidate.event_id, candidate);
  }

  return map;
};

const upsertAnalysis = async (client, postId, values) => {
  await client.query(
    `INSERT INTO post_analysis (
       post_id,
       has_claim,
       domain,
       claim_summary,
       entities,
       processing_status,
       processing_errors,
       candidates_count,
       gate_model,
       reason_model,
       gate_latency_ms,
       reason_latency_ms,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (post_id) DO UPDATE SET
       has_claim = EXCLUDED.has_claim,
       domain = EXCLUDED.domain,
       claim_summary = EXCLUDED.claim_summary,
       entities = EXCLUDED.entities,
       processing_status = EXCLUDED.processing_status,
       processing_errors = EXCLUDED.processing_errors,
       candidates_count = EXCLUDED.candidates_count,
       gate_model = EXCLUDED.gate_model,
       reason_model = EXCLUDED.reason_model,
       gate_latency_ms = EXCLUDED.gate_latency_ms,
       reason_latency_ms = EXCLUDED.reason_latency_ms,
       updated_at = NOW()`,
    [
      postId,
      values.has_claim,
      values.domain,
      values.claim_summary,
      values.entities,
      values.processing_status,
      values.processing_errors,
      values.candidates_count,
      values.gate_model,
      values.reason_model,
      values.gate_latency_ms,
      values.reason_latency_ms
    ]
  );
};

const updateCandidates = async (client, postId, candidates) => {
  const normalized = normalizeCandidates(candidates);
  await client.query('DELETE FROM post_market_matches WHERE post_id = $1', [postId]);
  if (normalized.length === 0) {
    return 0;
  }

  for (const candidate of normalized) {
    await client.query(
      `INSERT INTO post_market_matches (post_id, event_id, match_score, match_method)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (post_id, event_id)
       DO UPDATE SET
         match_score = EXCLUDED.match_score,
         match_method = EXCLUDED.match_method,
         updated_at = NOW()`,
      [postId, candidate.event_id, candidate.match_score, candidate.match_method]
    );
  }

  return normalized.length;
};

const withMatchMethod = (candidates, preferredMethod) => {
  if (!Array.isArray(candidates)) return [];

  return candidates.map((candidate) => ({
    ...candidate,
    match_method: candidate.match_method || preferredMethod
  }));
};

const clearDerivedMatchState = async (client, postId) => {
  await client.query(
    `DELETE FROM post_market_links
      WHERE post_id = $1
        AND source = 'auto_match'`,
    [postId]
  );

  await client.query('DELETE FROM conditional_flags WHERE post_id = $1', [postId]);
  await client.query('DELETE FROM post_critiques WHERE post_id = $1', [postId]);
  await client.query('DELETE FROM propositions WHERE post_id = $1', [postId]);
};

const insertArgumentGraph = async (client, postId, argumentResult) => {
  if (!argumentResult || !Array.isArray(argumentResult.propositions) || argumentResult.propositions.length === 0) {
    return {
      propositionsByLabel: {},
      conclusionPropId: null
    };
  }

  const propositionsByLabel = {};

  for (const proposition of argumentResult.propositions) {
    const propResult = await client.query(
      `INSERT INTO propositions (
         post_id,
         prop_type,
         content,
         formal,
         confidence_level,
         negated
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        postId,
        proposition.prop_type,
        proposition.content,
        proposition.formal || null,
        proposition.confidence_level || null,
        !!proposition.negated
      ]
    );

    const propositionId = propResult.rows[0]?.id;
    if (proposition.label) {
      propositionsByLabel[proposition.label] = propositionId;
    }
  }

  for (const relation of argumentResult.relations || []) {
    const fromPropId = propositionsByLabel[relation.from];
    const toPropId = propositionsByLabel[relation.to];
    if (!fromPropId || !toPropId) {
      continue;
    }

    await client.query(
      `INSERT INTO prop_relations (
         post_id,
         from_prop_id,
         to_prop_id,
         relation_type
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [postId, fromPropId, toPropId, relation.relation_type]
    );
  }

  const conclusionPropId = (argumentResult.propositions || [])
    .find((prop) => prop.prop_type === 'conclusion')
    ? propositionsByLabel[
    argumentResult.propositions.find((prop) => prop.prop_type === 'conclusion' && prop.label)?.label
    ] || null
    : null;

  return {
    propositionsByLabel,
    conclusionPropId
  };
};

const storeMarketLink = async (client, postId, bestMarket, candidateMap, conclusionPropId) => {
  if (!bestMarket?.event_id) {
    return null;
  }

  const candidate = candidateMap.get(bestMarket.event_id);
  const reasonedConfidence = Number.isFinite(bestMarket.confidence)
    ? bestMarket.confidence
    : null;

  const result = await client.query(
    `INSERT INTO post_market_links (
       post_id,
       event_id,
       conclusion_prop_id,
       stance,
       match_confidence,
       match_score,
       match_method,
       source,
       confirmed
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'auto_match', FALSE)
     ON CONFLICT (post_id, event_id)
     DO UPDATE SET
       conclusion_prop_id = EXCLUDED.conclusion_prop_id,
       stance = EXCLUDED.stance,
       match_confidence = EXCLUDED.match_confidence,
       match_score = EXCLUDED.match_score,
       match_method = EXCLUDED.match_method,
       source = 'auto_match',
       updated_at = NOW(),
       confirmed = FALSE
     RETURNING id`,
    [
      postId,
      bestMarket.event_id,
      conclusionPropId,
      bestMarket.stance,
      reasonedConfidence,
      candidate?.match_score || 0,
      candidate?.match_method || MATCH_METHOD_DEFAULT
    ]
  );

  return result.rows[0] || null;
};

const storeConditionalFlags = async (client, postId, conditionalFlags) => {
  if (!Array.isArray(conditionalFlags) || conditionalFlags.length === 0) {
    return;
  }

  for (const flag of conditionalFlags) {
    await client.query(
      `INSERT INTO conditional_flags (
         post_id,
         antecedent_event_id,
         consequent_event_id,
         antecedent_prop_id,
         consequent_prop_id,
         relationship
       ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (antecedent_event_id, consequent_event_id)
       DO UPDATE SET
         flag_count = conditional_flags.flag_count + 1,
         antecedent_prop_id = COALESCE(EXCLUDED.antecedent_prop_id, conditional_flags.antecedent_prop_id),
         consequent_prop_id = COALESCE(EXCLUDED.consequent_prop_id, conditional_flags.consequent_prop_id)
      `,
      [
        postId,
        flag.antecedent_event_id,
        flag.consequent_event_id,
        flag.antecedent_prop_id || null,
        flag.consequent_prop_id || null,
        flag.relationship
      ]
    );
  }
};

const storeCritiques = async (client, postId, critiques, propositionByLabel) => {
  if (!Array.isArray(critiques) || critiques.length === 0) {
    return;
  }

  for (const critique of critiques) {
    const relatedPropId = critique.related_prop
      ? propositionByLabel[critique.related_prop] || null
      : null;

    await client.query(
      `INSERT INTO post_critiques (
         post_id,
         critique_type,
         description,
         severity,
         related_prop_id
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        postId,
        critique.critique_type,
        critique.description,
        critique.severity,
        relatedPropId
      ]
    );
  }
};

const persistReasonerOutput = async (client, postId, argumentResult, candidates) => {
  await client.query('SAVEPOINT reasoner_output');

  try {
    const candidateMap = mapCandidatesByEventId(candidates);
    if (!argumentResult) {
      await client.query('ROLLBACK TO SAVEPOINT reasoner_output');
      return { hasMatch: false };
    }

    await clearDerivedMatchState(client, postId);

    const { propositionsByLabel, conclusionPropId } = await insertArgumentGraph(
      client,
      postId,
      argumentResult
    );

    const linkedMarket = argumentResult.best_market
      ? await storeMarketLink(
        client,
        postId,
        argumentResult.best_market,
        candidateMap,
        conclusionPropId
      )
      : null;

    await storeConditionalFlags(client, postId, argumentResult.conditional_flags);
    await storeCritiques(client, postId, argumentResult.critiques, propositionsByLabel);

    await client.query('RELEASE SAVEPOINT reasoner_output');

    return {
      hasMatch: !!linkedMarket,
      linkedMarket
    };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT reasoner_output');
    throw error;
  }
};

const runPipeline = async (postId, content) => {
  const start = Date.now();
  const normalizedContent = String(content || '').trim();
  const matchMethod = config.matchMethod || MATCH_METHOD_DEFAULT;
  const normalizedPostId = toPostId(postId);
  if (normalizedPostId === null) {
    throw new Error('Invalid post id');
  }

  if (!config.isEnabled) {
    await logPipelineResult({
      postId: normalizedPostId,
      status: 'not_started',
      candidateCount: 0,
      durationMs: Date.now() - start,
      processingErrors: 'matching disabled',
      reasonerAttempted: false,
      reasonerMatch: false
    });
    return {
      post_id: normalizedPostId,
      status: 'not_started',
      duration_ms: 0
    };
  }

  if (!config.gate.enabled) {
    await logPipelineResult({
      postId: normalizedPostId,
      status: 'not_started',
      candidateCount: 0,
      durationMs: Date.now() - start,
      processingErrors: 'gate disabled',
      reasonerAttempted: false,
      reasonerMatch: false
    });
    return {
      post_id: normalizedPostId,
      status: 'not_started',
      duration_ms: 0
    };
  }

  const pool = db.getPool();
  const client = await pool.connect();

  let capabilities;
  try {
    capabilities = await loadPipelineCapabilities();
  } catch (capabilitiesError) {
    client.release();
    console.error('[PostMatchPipeline] Failed to load matching capabilities:', capabilitiesError.message || capabilitiesError);
    await logPipelineResult({
      postId: normalizedPostId,
      status: 'not_started',
      candidateCount: 0,
      durationMs: Date.now() - start,
      processingErrors: normalizeErrorClass(capabilitiesError),
      reasonerAttempted: false,
      reasonerMatch: false
    });
    return {
      post_id: normalizedPostId,
      status: 'not_started',
      duration_ms: 0
    };
  }

  if (!canRunPipeline(capabilities)) {
    client.release();
    await logPipelineResult({
      postId: normalizedPostId,
      status: 'not_started',
      candidateCount: 0,
      durationMs: Date.now() - start,
      processingErrors: 'matching schema incomplete',
      reasonerAttempted: false,
      reasonerMatch: false
    });
    return {
      post_id: normalizedPostId,
      status: 'not_started',
      reason: 'matching_schema_incomplete',
      duration_ms: 0
    };
  }

  const reasonerTablesReady = canPersistReasoning(capabilities);

  try {
    await client.query('BEGIN');
    await upsertAnalysis(client, normalizedPostId, {
      has_claim: false,
      domain: null,
      claim_summary: null,
      entities: [],
      processing_status: 'pending',
      processing_errors: null,
      candidates_count: 0,
      gate_model: null,
      reason_model: null,
      gate_latency_ms: null,
      reason_latency_ms: null
    });

    if (!normalizedContent) {
      await upsertAnalysis(client, normalizedPostId, {
        has_claim: false,
        domain: null,
        claim_summary: null,
        entities: [],
        processing_status: 'gated_out',
        processing_errors: null,
        candidates_count: 0,
        gate_model: null,
        reason_model: null,
        gate_latency_ms: null,
        reason_latency_ms: null
      });
      await updateCandidates(client, normalizedPostId, []);
      await client.query('COMMIT');
      await logPipelineResult({
        postId: normalizedPostId,
        status: 'gated_out',
        candidateCount: 0,
        durationMs: Date.now() - start,
        processingErrors: null,
        reasonerAttempted: false,
        reasonerMatch: false
      });
      return {
        post_id: normalizedPostId,
        status: 'gated_out',
        duration_ms: Date.now() - start
      };
    }

    let gateResult = {
      has_claim: false,
      domain: null,
      claim_summary: null,
      entities: []
    };

    let candidates = [];
    let processingErrors = null;
    let reasonerAttempted = false;
    let hasReasonerMatch = false;
    let candidateCount = 0;
    let gateLatencyMs = null;
    let reasonLatencyMs = null;

    await upsertAnalysis(client, normalizedPostId, {
      has_claim: false,
      domain: null,
      claim_summary: null,
      entities: [],
      processing_status: 'retrieving',
      processing_errors: null,
      candidates_count: 0,
      gate_model: config.gate.model,
      reason_model: null,
      gate_latency_ms: null,
      reason_latency_ms: null
    });

    if (config.gate.enabled) {
      try {
        const gateStart = Date.now();
        gateResult = await runSafeGate({ postContent: normalizedContent });
        gateLatencyMs = Date.now() - gateStart;
      } catch (error) {
        processingErrors = normalizeResultError(error, 'gate failed');
      }
    }

    if (gateResult.has_claim) {
      candidates = await retrieveCandidateMarkets(
        gateResult.claim_summary || normalizedContent,
        gateResult.entities,
        gateResult.domain
      );
      candidates = withMatchMethod(candidates, matchMethod);
      candidateCount = await updateCandidates(client, normalizedPostId, candidates);
      await upsertAnalysis(client, normalizedPostId, {
        has_claim: true,
        domain: gateResult.domain || null,
        claim_summary: gateResult.claim_summary || null,
        entities: gateResult.entities || [],
        processing_status: candidates.length > 0 ? 'reasoning' : 'complete',
        processing_errors: processingErrors,
        candidates_count: candidateCount,
        gate_model: config.gate.model,
        reason_model: config.reasoner.enabled ? config.reasoner.model : null,
        gate_latency_ms: gateLatencyMs,
        reason_latency_ms: reasonLatencyMs
      });

      let wordCount = 0;
      if (candidates.length > 0 && config.reasoner.enabled && reasonerTablesReady) {
        try {
          reasonerAttempted = true;
          const reasonStart = Date.now();
          wordCount = normalizedContent.split(/\s+/).filter(Boolean).length;
          const isHeavy = wordCount > 400;

          const argumentResult = await runSafeReasoner({
            postContent: normalizedContent,
            candidates,
            overrideModel: isHeavy ? config.reasoner.heavyModel : null,
            overrideFallbackModels: isHeavy ? config.reasoner.heavyFallbackModels : null
          });
          reasonLatencyMs = Date.now() - reasonStart;

          const reasonerResult = await persistReasonerOutput(
            client,
            normalizedPostId,
            argumentResult,
            candidates
          );
          hasReasonerMatch = reasonerResult.hasMatch;
        } catch (error) {
          const reasoningError = normalizeResultError(error, 'reasoner failed');
          processingErrors = processingErrors
            ? `${processingErrors}; ${reasoningError}`
            : reasoningError;
        }
      }

      await upsertAnalysis(client, normalizedPostId, {
        has_claim: true,
        domain: gateResult.domain || null,
        claim_summary: gateResult.claim_summary || null,
        entities: gateResult.entities || [],
        processing_status: 'complete',
        processing_errors: processingErrors,
        candidates_count: candidateCount,
        gate_model: config.gate.model,
        reason_model: reasonerAttempted ? (wordCount > 400 ? config.reasoner.heavyModel : config.reasoner.model) : null,
        gate_latency_ms: gateLatencyMs,
        reason_latency_ms: reasonLatencyMs
      });

      await client.query('COMMIT');
      await logPipelineResult({
        postId: normalizedPostId,
        status: 'complete',
        candidateCount,
        durationMs: Date.now() - start,
        processingErrors,
        reasonerAttempted,
        reasonerMatch: hasReasonerMatch
      });
      return {
        post_id: normalizedPostId,
        status: 'complete',
        candidate_count: candidateCount,
        reasoner_match: hasReasonerMatch,
        duration_ms: Date.now() - start
      };
    }

    await upsertAnalysis(client, normalizedPostId, {
      has_claim: false,
      domain: null,
      claim_summary: null,
      entities: [],
      processing_status: 'gated_out',
      processing_errors: processingErrors,
      candidates_count: 0,
      gate_model: config.gate.model,
      reason_model: null,
      gate_latency_ms: gateLatencyMs,
      reason_latency_ms: reasonLatencyMs
    });
    await updateCandidates(client, normalizedPostId, []);
    await client.query('COMMIT');
    await logPipelineResult({
      postId: normalizedPostId,
      status: 'gated_out',
      candidateCount: 0,
      durationMs: Date.now() - start,
      processingErrors,
      reasonerAttempted: false,
      reasonerMatch: false
    });

    return {
      post_id: normalizedPostId,
      status: 'gated_out',
      duration_ms: Date.now() - start
    };
  } catch (error) {
    await client.query('ROLLBACK');
    const durationMs = Date.now() - start;

    try {
      await db.query(
        `INSERT INTO post_analysis (
           post_id, has_claim, processing_status, processing_errors, candidates_count, updated_at
         ) VALUES ($1, FALSE, 'failed', $2, 0, NOW())
         ON CONFLICT (post_id) DO UPDATE SET
           has_claim = FALSE,
           processing_status = 'failed',
           processing_errors = EXCLUDED.processing_errors,
           updated_at = NOW()`,
        [normalizedPostId, clampError(error)]
      );
    } catch (statusErr) {
      console.error('[PostMatchPipeline] Failed to persist error status:', statusErr.message || statusErr);
    }

    await logPipelineResult({
      postId: normalizedPostId,
      status: 'failed',
      candidateCount: 0,
      durationMs,
      processingErrors: clampError(error),
      reasonerAttempted: false,
      reasonerMatch: false
    });

    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  processPost: runPipeline,
  processPostForTesting: runPipeline
};
