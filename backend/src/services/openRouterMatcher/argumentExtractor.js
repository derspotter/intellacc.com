const { callLLMWithFallback } = require('./llmClient');
const config = require('./config');

const CLEAN_WS = /\s+/g;
const MAX_TEXT_LENGTH = 2200;
const PROPOSITION_TYPES = new Set([
  'premise',
  'conclusion',
  'assumption',
  'evidence',
  'conditional_antecedent'
]);
const CONFIDENCE_LEVELS = new Set([
  'assertion',
  'prediction',
  'speculation',
  'question',
  'conditional'
]);
const RELATION_TYPES = new Set([
  'supports',
  'implies',
  'contradicts',
  'conditional',
  'conjunction',
  'disjunction',
  'unless'
]);
const STANCES = new Set(['agrees', 'disagrees', 'related']);
const RELATIONSHIPS = new Set(['positive', 'negative', 'prerequisite']);
const CRITIQUE_TYPES = new Set([
  'unsupported_causal_claim',
  'contradiction',
  'ambiguous_timeframe',
  'unfalsifiable',
  'missing_base_rate',
  'cherry_picked_evidence',
  'false_dichotomy',
  'appeal_to_authority',
  'circular_reasoning',
  'non_sequitur',
  'hasty_generalization',
  'empirical_error',
  'unsupported_assumption',
  'data_mismatch',
  'logical_leap',
  'methodological_flaw',
  'overgeneralization',
  'confounding_variable',
  'unsubstantiated_mechanism',
  'conceptual_ambiguity'
]);
const SEVERITIES = new Set(['info', 'warning', 'error']);
const REASONER_JSON_SCHEMA = {
  name: 'post_match_reasoner_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'best_market',
      'propositions',
      'relations',
      'conditional_flags',
      'critiques'
    ],
    properties: {
      best_market: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['event_id', 'stance', 'confidence', 'reasoning'],
            properties: {
              event_id: { type: 'integer' },
              stance: { type: 'string', enum: ['agrees', 'disagrees', 'related'] },
              confidence: { type: 'number' },
              reasoning: { type: 'string' }
            }
          }
        ]
      },
      propositions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'type', 'content', 'formal', 'confidence_level', 'negated'],
          properties: {
            label: { type: 'string' },
            type: {
              type: 'string',
              enum: ['premise', 'conclusion', 'assumption', 'evidence', 'conditional_antecedent']
            },
            content: { type: 'string' },
            formal: {
              anyOf: [{ type: 'string' }, { type: 'null' }]
            },
            confidence_level: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'string',
                  enum: ['assertion', 'prediction', 'speculation', 'question', 'conditional']
                }
              ]
            },
            negated: { type: 'boolean' }
          }
        }
      },
      relations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to', 'type'],
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            type: {
              type: 'string',
              enum: ['supports', 'implies', 'contradicts', 'conditional', 'conjunction', 'disjunction', 'unless']
            }
          }
        }
      },
      conditional_flags: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['antecedent_event_id', 'consequent_event_id', 'relationship'],
          properties: {
            antecedent_event_id: { type: 'integer' },
            consequent_event_id: { type: 'integer' },
            relationship: { type: 'string', enum: ['positive', 'negative', 'prerequisite'] }
          }
        }
      },
      critiques: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'description', 'severity', 'related_prop', 'reasoning'],
          properties: {
            type: {
              type: 'string',
              enum: [
                'unsupported_causal_claim',
                'contradiction',
                'ambiguous_timeframe',
                'unfalsifiable',
                'missing_base_rate',
                'cherry_picked_evidence',
                'false_dichotomy',
                'appeal_to_authority',
                'circular_reasoning',
                'non_sequitur',
                'hasty_generalization',
                'empirical_error',
                'unsupported_assumption',
                'data_mismatch',
                'logical_leap',
                'methodological_flaw',
                'overgeneralization',
                'confounding_variable',
                'unsubstantiated_mechanism',
                'conceptual_ambiguity'
              ]
            },
            description: { type: 'string' },
            severity: { type: 'string', enum: ['info', 'warning', 'error'] },
            related_prop: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            reasoning: { type: 'string' }
          }
        }
      }
    }
  }
};

const cleanText = (value) => String(value || '')
  .replace(CLEAN_WS, ' ')
  .trim()
  .slice(0, MAX_TEXT_LENGTH);

const toInt = (value) => {
  const numeric = Number.parseInt(value, 10);
  return Number.isInteger(numeric) ? numeric : null;
};

const toFloat = (value, fallback = null) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
};

const normalizeLabel = (value, fallback = null) => {
  const clean = cleanText(value);
  return clean.length > 0 ? clean : fallback;
};

const toPostMatchOutput = (raw, candidates) => {
  const output = {
    propositions: [],
    relations: [],
    conditional_flags: [],
    critiques: [],
    best_market: null
  };

  if (!raw || typeof raw !== 'object') {
    return output;
  }

  const candidateIds = new Set(
    Array.isArray(candidates)
      ? candidates.map((candidate) => toInt(candidate.event_id)).filter(Number.isInteger)
      : []
  );

  if (raw.best_market && typeof raw.best_market === 'object') {
    const eventId = toInt(raw.best_market.event_id);
    const stance = STANCES.has(raw.best_market.stance) ? raw.best_market.stance : null;
    const confidence = toFloat(raw.best_market.confidence);
    if (eventId && candidateIds.has(eventId) && stance) {
      output.best_market = {
        event_id: eventId,
        stance,
        confidence: confidence == null ? null : Math.max(0, Math.min(1, confidence)),
        reasoning: cleanText(raw.best_market.reasoning)
      };
    }
  }

  if (Array.isArray(raw.propositions)) {
    const seen = new Set();
    output.propositions = raw.propositions
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        const label = normalizeLabel(item.label);
        if (!label) return null;

        const propType = PROPOSITION_TYPES.has(item.type) ? item.type : null;
        const content = cleanText(item.content);
        if (!propType || !content) return null;

        if (seen.has(label)) return null;
        seen.add(label);

        return {
          label,
          prop_type: propType,
          content,
          formal: normalizeLabel(item.formal),
          confidence_level: CONFIDENCE_LEVELS.has(item.confidence_level) ? item.confidence_level : null,
          negated: item.negated === true
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(raw.relations)) {
    const validLabels = new Set(output.propositions.map((prop) => prop.label));
    output.relations = raw.relations
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        const fromLabel = normalizeLabel(item.from);
        const toLabel = normalizeLabel(item.to);
        const relationType = RELATION_TYPES.has(item.type) ? item.type : null;
        if (!fromLabel || !toLabel || !relationType) return null;
        if (!validLabels.has(fromLabel) || !validLabels.has(toLabel)) return null;

        return {
          from: fromLabel,
          to: toLabel,
          relation_type: relationType
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(raw.conditional_flags)) {
    output.conditional_flags = raw.conditional_flags
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const antecedent = toInt(item.antecedent_event_id);
        const consequent = toInt(item.consequent_event_id);
        const relationship = RELATIONSHIPS.has(item.relationship) ? item.relationship : null;
        if (!antecedent || !consequent || !relationship) return null;

        return {
          antecedent_event_id: antecedent,
          consequent_event_id: consequent,
          relationship
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(raw.critiques)) {
    output.critiques = raw.critiques
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const type = CRITIQUE_TYPES.has(item.type) ? item.type : null;
        const severity = SEVERITIES.has(item.severity) ? item.severity : null;
        const description = cleanText(item.description);
        if (!type || !severity || !description) return null;

        return {
          critique_type: type,
          severity,
          description,
          related_prop: normalizeLabel(item.related_prop),
          reasoning: cleanText(item.reasoning)
        };
      })
      .filter(Boolean);
  }

  return output;
};

const buildPrompt = (postContent, candidates) => {
  const candidateText = candidates.map((candidate, index) => {
    const eventId = toInt(candidate.event_id);
    if (!eventId) return null;

    return `${index + 1}) [ID: ${eventId}] "${candidate.title || ''}"`;
  }).filter(Boolean).join('\n');

  return `You are a reasoning engine and 'kind tutor' for a prediction platform.
Analyze the post and map it to at most one best candidate market.
Additionally, you must evaluate the logical, empirical, and methodological soundness of the post.
Respond with JSON matching the response schema.

POST:
"""
${postContent}
"""

CANDIDATE MARKETS:
${candidateText}

Rules for Market Matching:
- best_market should be one of the provided market IDs in nearly all cases.
- Use best_market: null only if the post has no predictive claim at all or if no candidates are even remotely related.
- Even when uncertain, choose the closest market and lower confidence.
- Include only propositions/relations explicitly grounded in the post.
- Include at least 1 proposition and 1 relation when best_market is not null.

Rules for Critiques (Act as a Helpful Tutor and Rigorous Reviewer):
- **CRITICAL:** You MUST evaluate the text for critiques REGARDLESS of whether you find a matching best_market. The critique evaluation is entirely independent of market matching.
- Identify any of the following flaws if they are present: empirical_error, unsupported_assumption, data_mismatch, logical_leap, methodological_flaw, overgeneralization, confounding_variable, unsubstantiated_mechanism, conceptual_ambiguity.
- For lengthy or complex articles, perform a comprehensive and exhaustive review. You should aim to identify multiple distinct flaws (e.g., 3 to 7 critiques) across different categories to provide robust, multi-faceted feedback.
- Be constructive. In the 'reasoning' field of your critiques, briefly explain *why* the argument is flawed or the assumption is unsupported, and how the author might strengthen it.
- Do not be overly pedantic about casual language, but do flag serious logical, structural, or empirical gaps.
- Ensure your critiques capture the most critical vulnerabilities of the text's primary arguments.`;
};

const isDataPolicySchemaError = (error) => {
  const message = String(error?.message || '');
  return message.includes('No endpoints found matching your data policy');
};

const isLikelyEmptyContentError = (error) => {
  const message = String(error?.message || '');
  return message.includes('Empty model output') || message.includes('Model output is not JSON-like');
};

const buildReasonerExtraParams = ({ useSchema, includeReasoning }) => {
  const params = {
    include_reasoning: includeReasoning,
    reasoning: {
      enabled: true,
      max_tokens: config.reasoner.reasoningMaxTokens
    }
  };

  if (useSchema) {
    params.response_format = {
      type: 'json_schema',
      json_schema: REASONER_JSON_SCHEMA
    };
  }

  return params;
};

const runReasoner = async ({ postContent, candidates, overrideModel, overrideFallbackModels }) => {
  const messages = [{
    role: 'user',
    content: buildPrompt(postContent, candidates)
  }];

  const primaryModel = overrideModel || config.reasoner.model;
  const fallbackModels = overrideFallbackModels || config.reasoner.fallbackModels;

  const runCall = (extraParams) => callLLMWithFallback(
    {
      messages,
      maxTokens: config.reasoner.maxTokens,
      temperature: config.reasoner.temperature,
      timeoutMs: config.reasoner.timeoutMs,
      extraParams
    },
    {
      primaryModel,
      fallbackModels
    }
  );

  let raw;
  try {
    // Preferred path: strict schema + reasoning output enabled.
    raw = await runCall(buildReasonerExtraParams({
      useSchema: true,
      includeReasoning: true
    }));
  } catch (error) {
    // Some OpenRouter privacy/data policies reject schema enforcement per endpoint.
    if (!isDataPolicySchemaError(error) && !isLikelyEmptyContentError(error)) {
      throw error;
    }

    // Recovery path: keep reasoning enabled, but don't require schema.
    raw = await runCall(buildReasonerExtraParams({
      useSchema: false,
      includeReasoning: false
    }));
  }

  let normalized = toPostMatchOutput(raw, candidates);
  if (normalized.best_market || normalized.propositions.length > 0 || normalized.critiques.length > 0) {
    return normalized;
  }

  // One salvage retry for degenerate-but-valid empty outputs.
  raw = await runCall(buildReasonerExtraParams({
    useSchema: false,
    includeReasoning: false
  }));
  normalized = toPostMatchOutput(raw, candidates);
  return normalized;
};

const runSafeReasoner = async ({ postContent, candidates, overrideModel, overrideFallbackModels }) => {
  if (!config.reasoner.enabled) {
    return null;
  }

  if (!config.isEnabled) {
    return null;
  }

  if (!postContent || typeof postContent !== 'string' || postContent.trim().length < 5) {
    return null;
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  if (!config.openRouterApiKey) {
    throw new Error('OpenRouter API key missing');
  }

  return runReasoner({ postContent, candidates, overrideModel, overrideFallbackModels });
};

module.exports = {
  runSafeReasoner
};
