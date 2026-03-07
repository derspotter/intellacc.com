const config = require('./config');

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.FRONTEND_URL || 'https://intellacc.com',
  'X-Title': 'intellacc'
};

const toInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeUsage = (usage) => {
  const promptTokens = toInt(
    usage?.prompt_tokens
      ?? usage?.input_tokens
      ?? usage?.usage?.prompt_tokens
      ?? usage?.usage?.input_tokens
  );
  const completionTokens = toInt(
    usage?.completion_tokens
      ?? usage?.output_tokens
      ?? usage?.usage?.completion_tokens
      ?? usage?.usage?.output_tokens
  );
  const totalTokens = toInt(
    usage?.total_tokens
      ?? usage?.usage?.total_tokens,
    promptTokens + completionTokens
  );
  const reasoningTokens = toInt(
    usage?.reasoning_tokens
      ?? usage?.completion_tokens_details?.reasoning_tokens
      ?? usage?.output_tokens_details?.reasoning_tokens
      ?? usage?.usage?.reasoning_tokens
      ?? usage?.usage?.completion_tokens_details?.reasoning_tokens
      ?? usage?.usage?.output_tokens_details?.reasoning_tokens
  );
  const cachedTokens = toInt(
    usage?.cached_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens
      ?? usage?.usage?.cached_tokens
      ?? usage?.usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.usage?.input_tokens_details?.cached_tokens
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
    cachedTokens,
    costCredits: toNumber(
      usage?.cost
        ?? usage?.usage?.cost
        ?? usage?.cost_credits
        ?? usage?.usage?.cost_credits
    )
  };
};

const extractProviderError = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || !parsed.error) {
    return null;
  }

  const message = parsed.error?.message || parsed.error?.error || 'Provider request failed';
  const code = parsed.error?.code;
  return code ? `${message} (code: ${code})` : String(message);
};

const recordUsageAttempt = async (usageRecorder, payload) => {
  if (typeof usageRecorder !== 'function') {
    return;
  }

  try {
    await usageRecorder(payload);
  } catch (error) {
    console.error('[Matcher] Failed to record usage attempt:', error.message || error);
  }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableEmbeddingError = (error) => {
  const message = String(error?.message || '');
  return (
    message.includes('No successful provider responses')
    || message.includes('temporarily unavailable')
    || message.includes('rate limit')
    || message.includes('429')
    || message.includes('502')
    || message.includes('503')
    || message.includes('504')
  );
};

const callLLM = async ({
  model,
  messages,
  maxTokens,
  temperature,
  extraParams = {},
  timeoutMs,
  usageRecorder,
  usageContext = {}
}) => {
  if (!config.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required');
  }

  const body = {
    model,
    messages,
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0,
    max_tokens: maxTokens || 300,
    usage: { include: true },
    ...extraParams
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
  const startedAt = Date.now();

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
    const providerError = extractProviderError(parsed);
    if (providerError) {
      throw new Error(providerError);
    }
    const content = parsed?.choices?.[0]?.message?.content;
    const result = {
      output: parseJsonResponse(content),
      usage: normalizeUsage(parsed?.usage),
      requestedModel: model,
      usedModel: parsed?.model || model,
      providerResponseId: parsed?.id || null
    };

    await recordUsageAttempt(usageRecorder, {
      stage: usageContext.stage || 'unknown',
      operation: usageContext.operation || 'chat_completion',
      success: true,
      latencyMs: Date.now() - startedAt,
      requestedModel: result.requestedModel,
      usedModel: result.usedModel,
      providerResponseId: result.providerResponseId,
      ...result.usage
    });

    return result;
  } catch (error) {
    await recordUsageAttempt(usageRecorder, {
      stage: usageContext.stage || 'unknown',
      operation: usageContext.operation || 'chat_completion',
      success: false,
      latencyMs: Date.now() - startedAt,
      requestedModel: model,
      usedModel: model,
      providerResponseId: null,
      ...normalizeUsage(null),
      errorClass: error?.name || error?.code || 'Error',
      errorMessage: error?.message || String(error)
    });
    throw error;
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

const callEmbedding = async ({
  input,
  model,
  timeoutMs,
  usageRecorder,
  usageContext = {}
}) => {
  if (!config.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required');
  }

  const maxAttempts = Math.max(1, config.embedding.retryAttempts || 1);
  const backoffMs = Math.max(100, config.embedding.retryBackoffMs || 500);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
    const startedAt = Date.now();

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
      const providerError = extractProviderError(parsed);
      if (providerError) {
        throw new Error(providerError);
      }
      const embeddingPayload = Array.isArray(parsed?.data)
        ? parsed.data[0]
        : parsed?.data;
      const embedding = embeddingPayload?.embedding || parsed?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('Embedding output missing embedding vector');
      }

      const result = {
        embedding,
        usage: normalizeUsage(parsed?.usage),
        requestedModel: model,
        usedModel: parsed?.model || model,
        providerResponseId: parsed?.id || null
      };

      await recordUsageAttempt(usageRecorder, {
        stage: usageContext.stage || 'unknown',
        operation: usageContext.operation || 'embedding',
        success: true,
        latencyMs: Date.now() - startedAt,
        requestedModel: result.requestedModel,
        usedModel: result.usedModel,
        providerResponseId: result.providerResponseId,
        ...result.usage
      });

      return result;
    } catch (error) {
      lastError = error;
      await recordUsageAttempt(usageRecorder, {
        stage: usageContext.stage || 'unknown',
        operation: usageContext.operation || 'embedding',
        success: false,
        latencyMs: Date.now() - startedAt,
        requestedModel: model,
        usedModel: model,
        providerResponseId: null,
        ...normalizeUsage(null),
        errorClass: error?.name || error?.code || 'Error',
        errorMessage: error?.message || String(error)
      });

      const shouldRetry = attempt < maxAttempts && isRetryableEmbeddingError(error);
      if (!shouldRetry) {
        throw error;
      }

      await sleep(backoffMs * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('Embedding call failed');
};

module.exports = {
  callLLM,
  callLLMWithFallback,
  callEmbedding,
  parseJsonResponse
};
