const db = require('../../db');
const { randomUUID } = require('crypto');
const config = require('./config');
const { runSafeGate } = require('./claimGate');
const { retrieveCandidateMarkets } = require('./marketRetrieval');
const { runSafeReasoner } = require('./argumentExtractor');
const { extractFirstUrl, fetchArticleContent } = require('../metadata/metadataService');

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
const USAGE_LOG_TABLE = 'post_match_api_usage';
const EMPTY_USAGE_SUMMARY = Object.freeze({
  api_call_count: 0,
  api_success_count: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  reasoning_tokens: 0,
  cached_tokens: 0,
  cost_credits: 0
});

let schemaCapabilityCache = null;

const shouldIgnoreLoggingError = (error) => {
  const code = String(error?.code || '').trim();
  return code === '42P01' || code === '23503';
};

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

const toSafeInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const toSafeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeUsageRecord = (record) => ({
  stage: String(record?.stage || 'unknown'),
  operation: String(record?.operation || 'unknown'),
  requestedModel: record?.requestedModel ? String(record.requestedModel) : null,
  usedModel: record?.usedModel ? String(record.usedModel) : null,
  success: record?.success === true,
  latencyMs: toSafeInt(record?.latencyMs, null),
  promptTokens: toSafeInt(record?.promptTokens),
  completionTokens: toSafeInt(record?.completionTokens),
  totalTokens: toSafeInt(record?.totalTokens),
  reasoningTokens: toSafeInt(record?.reasoningTokens),
  cachedTokens: toSafeInt(record?.cachedTokens),
  costCredits: toSafeNumber(record?.costCredits),
  providerResponseId: record?.providerResponseId ? String(record.providerResponseId) : null,
  errorClass: record?.errorClass ? String(record.errorClass) : null,
  errorMessage: record?.errorMessage ? clampError(record.errorMessage) : null
});

const summarizeUsageRecords = (records = []) => records.reduce((summary, record) => {
  const normalized = normalizeUsageRecord(record);
  summary.api_call_count += 1;
  if (normalized.success) {
    summary.api_success_count += 1;
  }
  summary.prompt_tokens += normalized.promptTokens;
  summary.completion_tokens += normalized.completionTokens;
  summary.total_tokens += normalized.totalTokens;
  summary.reasoning_tokens += normalized.reasoningTokens;
  summary.cached_tokens += normalized.cachedTokens;
  summary.cost_credits += normalized.costCredits;
  return summary;
}, { ...EMPTY_USAGE_SUMMARY });

const logPipelineRun = async ({
  postId,
  status,
  candidateCount = 0,
  durationMs = null,
  processingErrors = null,
  error,
  usageSummary = EMPTY_USAGE_SUMMARY,
  reasonerAttempted = false,
  reasonerMatch = false
}) => {
  try {
    await db.query(
      `INSERT INTO ${RUN_LOG_TABLE} (
         post_id, status, candidate_count, duration_ms, processing_errors,
         error_class, gate_enabled, reasoner_enabled, reasoner_attempted, reasoner_match,
         api_call_count, api_success_count, prompt_tokens, completion_tokens,
         total_tokens, reasoning_tokens, cached_tokens, cost_credits
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
        reasonerMatch,
        usageSummary.api_call_count,
        usageSummary.api_success_count,
        usageSummary.prompt_tokens,
        usageSummary.completion_tokens,
        usageSummary.total_tokens,
        usageSummary.reasoning_tokens,
        usageSummary.cached_tokens,
        usageSummary.cost_credits
      ]
    );
  } catch (logError) {
    if (shouldIgnoreLoggingError(logError)) {
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
  usageSummary = EMPTY_USAGE_SUMMARY,
  reasonerAttempted = false,
  reasonerMatch = false
}) => {
  await logPipelineRun({
    postId,
    status,
    candidateCount,
    durationMs,
    processingErrors,
    usageSummary,
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

const upsertAnalysis = async (client, postId, values, run, claim = false) => {
  const result = await client.query(
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
       api_call_count,
       api_success_count,
       prompt_tokens,
       completion_tokens,
       total_tokens,
       reasoning_tokens,
       cached_tokens,
       cost_credits,
       processing_run_id,
       updated_at
     )
     SELECT $1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW()
     FROM (SELECT id FROM posts WHERE id = $1 AND COALESCE(content, '') = $23 FOR UPDATE) current_post
     WHERE TRUE
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
       api_call_count = EXCLUDED.api_call_count,
       api_success_count = EXCLUDED.api_success_count,
       prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens,
       total_tokens = EXCLUDED.total_tokens,
       reasoning_tokens = EXCLUDED.reasoning_tokens,
       cached_tokens = EXCLUDED.cached_tokens,
       cost_credits = EXCLUDED.cost_credits,
       processing_run_id = EXCLUDED.processing_run_id,
       updated_at = NOW()
     WHERE $22::boolean OR post_analysis.processing_run_id = EXCLUDED.processing_run_id
     RETURNING post_id`,
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
      values.reason_latency_ms,
      values.api_call_count ?? 0,
      values.api_success_count ?? 0,
      values.prompt_tokens ?? 0,
      values.completion_tokens ?? 0,
      values.total_tokens ?? 0,
      values.reasoning_tokens ?? 0,
      values.cached_tokens ?? 0,
      values.cost_credits ?? 0,
      run.id,
      claim,
      run.content
    ]
  );
  return result.rows.length > 0;
};

const persistUsageRecords = async ({ postId, records }) => {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }

  try {
    for (const record of records) {
      const normalized = normalizeUsageRecord(record);
      await db.query(
        `INSERT INTO ${USAGE_LOG_TABLE} (
           post_id, stage, operation, requested_model, used_model,
           success, latency_ms, prompt_tokens, completion_tokens, total_tokens,
           reasoning_tokens, cached_tokens, cost_credits, provider_response_id,
           error_class, error_message
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          postId,
          normalized.stage,
          normalized.operation,
          normalized.requestedModel,
          normalized.usedModel,
          normalized.success,
          normalized.latencyMs,
          normalized.promptTokens,
          normalized.completionTokens,
          normalized.totalTokens,
          normalized.reasoningTokens,
          normalized.cachedTokens,
          normalized.costCredits,
          normalized.providerResponseId,
          normalized.errorClass,
          normalized.errorMessage
        ]
      );
    }
  } catch (error) {
    if (shouldIgnoreLoggingError(error)) {
      return;
    }

    console.error('[PostMatchPipeline] Failed to persist API usage rows:', error.message || error);
  }
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

  // An author-confirmed link (manual attach or confirmed auto-match) outranks
  // the reasoner: never clobber it or add a competing auto link beside it.
  const confirmedLink = await client.query(
    'SELECT 1 FROM post_market_links WHERE post_id = $1 AND confirmed = TRUE LIMIT 1',
    [postId]
  );
  if (confirmedLink.rows.length > 0) {
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

// Acquire a client only for final database writes. The row locks fence out a
// newer run and a concurrent post edit until the result commits.
const persistPipelineResult = async ({ postId, run, analysis, candidates, argumentResult }) => {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    // Always lock the post before its analysis, matching progress/claim writes.
    const post = await client.query(
      "SELECT id FROM posts WHERE id = $1 AND COALESCE(content, '') = $2 FOR UPDATE",
      [postId, run.content]
    );
    const current = await client.query(
      `SELECT post_id FROM post_analysis
       WHERE post_id = $1 AND processing_run_id = $2 FOR UPDATE`,
      [postId, run.id]
    );
    if (post.rows.length === 0 || current.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    analysis.candidates_count = await updateCandidates(client, postId, candidates);
    let hasMatch = false;
    if (argumentResult !== undefined) {
      try {
        const result = await persistReasonerOutput(client, postId, argumentResult, candidates);
        hasMatch = result.hasMatch;
      } catch (error) {
        // persistReasonerOutput rolls back its savepoint, preserving candidates.
        const reasonError = normalizeResultError(error, 'reasoner failed');
        analysis.processing_errors = analysis.processing_errors
          ? `${analysis.processing_errors}; ${reasonError}` : reasonError;
      }
    }
    await upsertAnalysis(client, postId, analysis, run);
    await client.query('COMMIT');
    return { hasMatch };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    // Usage/run logging uses pool queries and must happen after this release.
    client.release();
  }
};

const runPipeline = async (postId, content) => {
  const start = Date.now();
  const run = { id: randomUUID(), content: String(content || '') };
  const normalizedContent = run.content.trim();
  const matchMethod = config.matchMethod || MATCH_METHOD_DEFAULT;
  const normalizedPostId = toPostId(postId);
  if (normalizedPostId === null) throw new Error('Invalid post id');

  const usageRecords = [];
  const usageRecorder = async (record) => { usageRecords.push(normalizeUsageRecord(record)); };
  const currentUsageSummary = () => summarizeUsageRecords(usageRecords);
  let reasonerAttempted = false;
  let hasReasonerMatch = false;
  const analysis = {
    has_claim: false, domain: null, claim_summary: null, entities: [],
    processing_status: 'pending', processing_errors: null, candidates_count: 0,
    gate_model: null, reason_model: null, gate_latency_ms: null, reason_latency_ms: null
  };
  const finish = async (status, processingErrors = analysis.processing_errors) => {
    await persistUsageRecords({ postId: normalizedPostId, records: usageRecords });
    await logPipelineResult({
      postId: normalizedPostId,
      // Run logs predate supersession. Keep their existing status constraint.
      status: status === 'superseded' ? 'not_started' : status,
      candidateCount: status === 'superseded' ? 0 : analysis.candidates_count,
      durationMs: Date.now() - start,
      processingErrors: status === 'superseded' ? 'superseded' : processingErrors,
      usageSummary: currentUsageSummary(), reasonerAttempted, reasonerMatch: hasReasonerMatch
    });
    return {
      post_id: normalizedPostId, status,
      candidate_count: status === 'superseded' ? 0 : analysis.candidates_count,
      reasoner_match: hasReasonerMatch, duration_ms: Date.now() - start
    };
  };

  if (!config.isEnabled) return finish('not_started', 'matching disabled');
  if (!config.gate.enabled) return finish('not_started', 'gate disabled');

  // Capability discovery itself uses the pool: do not reserve a client first.
  let capabilities;
  try {
    capabilities = await loadPipelineCapabilities();
  } catch (error) {
    console.error('[PostMatchPipeline] Failed to load matching capabilities:', error.message || error);
    return finish('not_started', normalizeErrorClass(error));
  }
  if (!canRunPipeline(capabilities)) {
    return { ...await finish('not_started', 'matching schema incomplete'), reason: 'matching_schema_incomplete' };
  }

  // Each progress write is autocommitted and visible to the polling endpoint.
  // The UUID guard also works across backend processes: a superseded run cannot
  // change progress, final results, or a newer run's failure state.
  const progress = (claim = false) => upsertAnalysis(
    db, normalizedPostId, { ...analysis, ...currentUsageSummary() }, run, claim
  );
  try {
    if (!await progress(true)) return finish('superseded');
    let candidates = [];
    let argumentResult;

    if (normalizedContent) {
      let augmentedContent = normalizedContent;
      const extractedLink = extractFirstUrl(normalizedContent);
      if (extractedLink) {
        try {
          const articleText = await fetchArticleContent(extractedLink);
          if (articleText && articleText.length > 50) {
            const truncated = articleText.length > 10000 ? `${articleText.substring(0, 10000)}... (truncated)` : articleText;
            augmentedContent = `User's Post:\n${normalizedContent}\n\nLinked Article Content:\n${truncated}`;
          }
        } catch (error) {
          console.warn('[PostMatchPipeline] Failed to augment content with article:', error.message);
        }
      }

      analysis.processing_status = 'retrieving';
      analysis.gate_model = config.gate.model;
      if (!await progress()) return finish('superseded');
      let gateResult = { has_claim: false };
      try {
        const gateStart = Date.now();
        gateResult = await runSafeGate({ postContent: augmentedContent, usageRecorder });
        analysis.gate_latency_ms = Date.now() - gateStart;
      } catch (error) {
        analysis.processing_errors = normalizeResultError(error, 'gate failed');
      }

      if (gateResult.has_claim) {
        analysis.has_claim = true;
        analysis.domain = gateResult.domain || null;
        analysis.claim_summary = gateResult.claim_summary || null;
        analysis.entities = gateResult.entities || [];
        if (!await progress()) return finish('superseded');
        candidates = withMatchMethod(await retrieveCandidateMarkets(
          gateResult.claim_summary || augmentedContent, gateResult.entities,
          gateResult.domain, { usageRecorder }
        ), matchMethod);
        analysis.candidates_count = normalizeCandidates(candidates).length;

        const shouldReason = candidates.length > 0 && config.reasoner.enabled && canPersistReasoning(capabilities);
        analysis.processing_status = shouldReason ? 'reasoning' : 'retrieving';
        analysis.reason_model = shouldReason ? config.reasoner.model : null;
        if (!await progress()) return finish('superseded');
        if (shouldReason) {
          reasonerAttempted = true;
          const isHeavy = augmentedContent.split(/\s+/).filter(Boolean).length > 400;
          analysis.reason_model = isHeavy ? config.reasoner.heavyModel : config.reasoner.model;
          try {
            const reasonStart = Date.now();
            argumentResult = await runSafeReasoner({
              postContent: augmentedContent, candidates,
              overrideModel: isHeavy ? config.reasoner.heavyModel : null,
              overrideFallbackModels: isHeavy ? config.reasoner.heavyFallbackModels : null,
              usageRecorder
            });
            analysis.reason_latency_ms = Date.now() - reasonStart;
          } catch (error) {
            const reasonError = normalizeResultError(error, 'reasoner failed');
            analysis.processing_errors = analysis.processing_errors
              ? `${analysis.processing_errors}; ${reasonError}` : reasonError;
          }
        }
      }
    }

    analysis.processing_status = analysis.has_claim ? 'complete' : 'gated_out';
    Object.assign(analysis, currentUsageSummary());
    const persisted = await persistPipelineResult({
      postId: normalizedPostId, run, analysis, candidates, argumentResult
    });
    if (!persisted) return finish('superseded');
    hasReasonerMatch = persisted.hasMatch;
    return finish(analysis.processing_status);
  } catch (error) {
    // No transaction/client remains here, even after persistence fails.
    analysis.processing_status = 'failed';
    analysis.has_claim = false;
    analysis.candidates_count = 0;
    analysis.processing_errors = clampError(error);
    try {
      await progress();
    } catch (statusError) {
      console.error('[PostMatchPipeline] Failed to persist error status:', statusError.message || statusError);
    }
    await finish('failed');
    throw error;
  }
};

module.exports = {
  processPost: runPipeline,
  processPostForTesting: runPipeline
};
