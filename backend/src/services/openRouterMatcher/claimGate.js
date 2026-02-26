const { callLLMWithFallback } = require('./llmClient');
const config = require('./config');

const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const normalizeArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => cleanText(entry))
    .filter((entry) => entry.length > 0);
};

const normalizeDomain = (domain) => {
  if (!domain) return null;
  return config.normalizeDomain(String(domain).trim().toLowerCase());
};

const buildPrompt = (postContent) => `Analyze this social-media style post.
Return strict JSON with keys:
{
  "has_claim": boolean,
  "domain": one of: ${config.DEFAULT_DOMAINS.join(', ')},
  "claim_summary": "neutral short claim statement or null",
  "entities": ["named entity 1", "entity 2"]
}

Rules:
- has_claim is true only when the post contains a falsifiable prediction or verifiable claim about a future outcome.
- claim_summary must be concise, neutral, and reusable for retrieval.
- entities should include 2-6 high-signal terms (or empty array).
- If there is no claim, set has_claim to false, claim_summary to null and entities to [].

Post:
"""
${postContent}
"""`;

const buildRetryPrompt = (postContent) => `Re-run as JSON only, retrying output format from:
{"has_claim":boolean,"domain":string|null,"claim_summary":string|null,"entities":[...]}
For the same post, return claim_summary even if uncertain.

Post:
"""
${postContent}
"""`;

const toPostMatchResult = (raw) => {
  const hasClaim = typeof raw?.has_claim === 'boolean' ? raw.has_claim : false;
  const domain = normalizeDomain(raw?.domain);
  const claimSummary = hasClaim ? cleanText(raw?.claim_summary) || null : null;
  const entities = normalizeArray(raw?.entities).slice(0, 12);

  return {
    has_claim: hasClaim,
    domain,
    claim_summary: claimSummary,
    entities
  };
};

const runGate = async (content) => {
  const messages = [{ role: 'user', content: buildPrompt(content) }];

  const first = await callLLMWithFallback(
    {
      messages,
      maxTokens: config.gate.maxTokens,
      temperature: config.gate.temperature,
      timeoutMs: config.gate.timeoutMs
    },
    {
      primaryModel: config.gate.model,
      fallbackModels: config.gate.fallbackModels
    }
  );

  const parsed = toPostMatchResult(first);
  if (parsed.has_claim && !parsed.claim_summary) {
    const second = await callLLMWithFallback(
      {
        messages: [{ role: 'user', content: buildRetryPrompt(content) }],
        maxTokens: config.gate.maxTokens,
        temperature: config.gate.temperature,
        timeoutMs: config.gate.timeoutMs
      },
      {
        primaryModel: config.gate.model,
        fallbackModels: config.gate.fallbackModels
      }
    );
    const retried = toPostMatchResult(second);
    if (retried.has_claim && retried.claim_summary) {
      return retried;
    }
  }

  return parsed;
};

const runSafeGate = async ({ postContent }) => {
  if (!config.gate.enabled) {
    return {
      has_claim: false,
      domain: null,
      claim_summary: null,
      entities: []
    };
  }

  if (!config.isEnabled) {
    return {
      has_claim: false,
      domain: null,
      claim_summary: null,
      entities: []
    };
  }

  if (!postContent || typeof postContent !== 'string' || postContent.trim().length < 5) {
    return {
      has_claim: false,
      domain: null,
      claim_summary: null,
      entities: []
    };
  }

  if (!config.openRouterApiKey) {
    throw new Error('OpenRouter API key missing');
  }

  return runGate(postContent);
};

module.exports = {
  runSafeGate,
  runGate,
  buildPrompt
};
