const config = require('./config');

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.FRONTEND_URL || 'https://intellacc.com',
  'X-Title': 'intellacc'
};

const parseJsonResponse = (text) => {
  if (!text) {
    throw new Error('Empty model output');
  }

  let cleaned = String(text).trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Model output is not JSON-like: ${cleaned.slice(0, 200)}`);
  }

  return JSON.parse(match[0]);
};

const getModelCandidates = (primaryModel, fallbackModels, fallbackList) => {
  const models = [primaryModel, ...fallbackModels, ...fallbackList].filter(Boolean);
  const deduped = [];
  const seen = new Set();
  for (const model of models) {
    if (seen.has(model)) continue;
    seen.add(model);
    deduped.push(model);
  }
  return deduped;
};

const callLLM = async ({
  model,
  messages,
  maxTokens,
  temperature,
  extraParams = {},
  timeoutMs
}) => {
  if (!config.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required');
  }

  const body = {
    model,
    messages,
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0,
    max_tokens: maxTokens || 300,
    ...extraParams
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);

  try {
    const response = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        ...DEFAULT_HEADERS
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter API ${response.status}: ${raw}`);
    }

    const parsed = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content;
    return parseJsonResponse(content);
  } finally {
    clearTimeout(timer);
  }
};

const callLLMWithFallback = async (options, {
  primaryModel,
  fallbackModels = []
}) => {
  const candidates = getModelCandidates(primaryModel, fallbackModels, []);
  let lastErr;

  for (let i = 0; i < candidates.length; i += 1) {
    try {
      return await callLLM({ ...options, model: candidates[i] });
    } catch (error) {
      lastErr = error;
      if (i >= candidates.length - 1) break;
    }
  }

  throw lastErr || new Error('LLM call failed');
};

const callEmbedding = async ({ input, model, timeoutMs }) => {
  if (!config.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);

  try {
    const response = await fetch(`${config.openRouterBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input,
        ...(config.embedding.dimensions ? { dimensions: config.embedding.dimensions } : {})
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter embedding API ${response.status}: ${raw}`);
    }

    const parsed = JSON.parse(raw);
    const embedding = parsed?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error('Embedding output missing embedding vector');
    }

    return embedding;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = {
  callLLM,
  callLLMWithFallback,
  callEmbedding,
  parseJsonResponse
};
