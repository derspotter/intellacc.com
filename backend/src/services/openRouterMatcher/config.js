const DEFAULT_DOMAINS = [
  'politics',
  'economics',
  'finance',
  'crypto',
  'technology',
  'science',
  'sports',
  'culture',
  'climate',
  'conflict'
];

const toInt = (value, fallback) => {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined) return fallback;

  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const normalizeDomain = (domain) => {
  if (!domain) return null;
  return DEFAULT_DOMAINS.includes(domain) ? domain : null;
};

module.exports = {
  DEFAULT_DOMAINS,
  normalizeDomain,
  isEnabled: toBool(process.env.POST_SIGNAL_AGENTIC_MATCH_ENABLED, false),
  gate: {
    enabled: toBool(process.env.POST_SIGNAL_MATCH_GATE_ENABLED, true),
    model: process.env.POST_SIGNAL_MATCH_GATE_MODEL || 'xiaomi/mimo-v2-flash',
    fallbackModels: process.env.POST_SIGNAL_MATCH_GATE_FALLBACK_MODELS
      ? process.env.POST_SIGNAL_MATCH_GATE_FALLBACK_MODELS
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
      : [],
    temperature: Number(process.env.POST_SIGNAL_MATCH_GATE_TEMPERATURE || '0'),
    maxTokens: toInt(process.env.POST_SIGNAL_MATCH_GATE_MAX_TOKENS, 300),
    timeoutMs: toInt(process.env.POST_SIGNAL_MATCH_GATE_TIMEOUT_MS, 10000)
  },
  reasoner: {
    enabled: toBool(process.env.POST_SIGNAL_MATCH_REASONER_ENABLED, false),
    model: process.env.POST_SIGNAL_MATCH_REASONER_MODEL || 'z-ai/glm-5',
    heavyModel: process.env.POST_SIGNAL_MATCH_REASONER_HEAVY_MODEL || 'google/gemini-3.1-pro-preview',
    fallbackModels: process.env.POST_SIGNAL_MATCH_REASONER_FALLBACK_MODELS
      ? process.env.POST_SIGNAL_MATCH_REASONER_FALLBACK_MODELS
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
      : [],
    heavyFallbackModels: process.env.POST_SIGNAL_MATCH_REASONER_HEAVY_FALLBACK_MODELS
      ? process.env.POST_SIGNAL_MATCH_REASONER_HEAVY_FALLBACK_MODELS
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
      : [],
    temperature: Number(process.env.POST_SIGNAL_MATCH_REASONER_TEMPERATURE || '0'),
    maxTokens: toInt(process.env.POST_SIGNAL_MATCH_REASONER_MAX_TOKENS, 1000),
    timeoutMs: toInt(process.env.POST_SIGNAL_MATCH_REASONER_TIMEOUT_MS, 12000),
    reasoningMaxTokens: toInt(process.env.POST_SIGNAL_MATCH_REASONING_MAX_TOKENS, 512)
  },
  retrieval: {
    enabled: toBool(process.env.POST_SIGNAL_MATCH_PIPELINE_ENABLED, true),
    candidateLimit: Math.max(1, toInt(process.env.POST_SIGNAL_MATCH_CANDIDATE_LIMIT, 15)),
    websearchToTsquery: toBool(process.env.POST_SIGNAL_MATCH_USE_WEBSEARCH_TSQUERY, true)
  },
  embedding: {
    model: process.env.POST_SIGNAL_MATCH_EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: toInt(process.env.POST_SIGNAL_MATCH_EMBEDDING_DIMENSIONS, 768),
    timeoutMs: toInt(process.env.POST_SIGNAL_MATCH_EMBEDDING_TIMEOUT_MS, 10000)
  },
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  matchMethod: process.env.POST_SIGNAL_MATCH_METHOD_NAME || 'hybrid_v1'
};
