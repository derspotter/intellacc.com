// Provider clients for the personal BYOK assistant.
//
// Fixed HTTPS endpoints only (no user-supplied base URLs), redirects are an
// error, requests time out, and both the request and the response are
// bounded. Errors are mapped to short codes; provider bodies, prompts and keys
// are never logged or returned to clients.
//
// Wire formats (verified against the official docs on 2026-09-18):
//   openai     POST /v1/responses          (Responses API, store:false)
//   anthropic  POST /v1/messages           (system separate, anthropic-version)
//   openrouter POST /api/v1/chat/completions
//   xai        POST /v1/chat/completions
const PROVIDERS = Object.freeze({
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', style: 'chat', label: 'OpenRouter' },
  openai: { url: 'https://api.openai.com/v1/responses', style: 'responses', label: 'OpenAI' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', style: 'anthropic', label: 'Anthropic' },
  xai: { url: 'https://api.x.ai/v1/chat/completions', style: 'chat', label: 'xAI' }
});
const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const API_KEY_PATTERN = /^[\x21-\x7E]{8,512}$/;

const clampInt = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const LIMITS = Object.freeze({
  maxOutputTokens: clampInt(process.env.AI_MAX_OUTPUT_TOKENS, 1024, 64, 4096),
  timeoutMs: clampInt(process.env.AI_PROVIDER_TIMEOUT_MS, 60000, 5000, 120000),
  maxResponseBytes: 1024 * 1024,
  maxAssistantChars: 16000,
  maxRequestChars: 60000
});

class AiProviderError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const isValidProvider = (provider) => Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
const isValidModel = (model) => typeof model === 'string' && MODEL_PATTERN.test(model);
const isValidApiKey = (apiKey) => typeof apiKey === 'string' && API_KEY_PATTERN.test(apiKey);

// Providers with strict turn alternation (Anthropic) reject consecutive
// same-role turns; merging is harmless for the chat-completion style APIs.
const normalizeTurns = (messages) => {
  const turns = [];
  for (const message of messages || []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(message?.content || '').trim();
    if (!content) continue;
    if (turns.length === 0 && role === 'assistant') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  if (turns.length === 0) throw new AiProviderError('bad_request', 'No user message to send');
  if (turns[turns.length - 1].role !== 'user') throw new AiProviderError('bad_request', 'Last turn must be from the user');
  return turns;
};

const buildRequest = ({ provider, model, apiKey, system, messages, maxTokens }) => {
  const spec = PROVIDERS[provider];
  const turns = normalizeTurns(messages);
  const max = clampInt(maxTokens, LIMITS.maxOutputTokens, 1, LIMITS.maxOutputTokens);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  let body;
  if (spec.style === 'responses') {
    headers.authorization = `Bearer ${apiKey}`;
    body = {
      model,
      store: false,
      max_output_tokens: max,
      instructions: system,
      input: turns.map((turn) => ({ role: turn.role, content: turn.content }))
    };
  } else if (spec.style === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    body = { model, max_tokens: max, system, messages: turns };
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      headers['http-referer'] = 'https://intellacc.com';
      headers['x-title'] = 'Intellacc';
    }
    body = { model, max_tokens: max, messages: [{ role: 'system', content: system }, ...turns] };
  }
  const json = JSON.stringify(body);
  if (json.length > LIMITS.maxRequestChars) throw new AiProviderError('bad_request', 'Prompt is too large');
  return { url: spec.url, headers, body: json };
};

const textFromParts = (parts, type = 'text') => {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && typeof part === 'object' && part.type === type && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
};

const parseResponse = (style, data) => {
  if (!data || typeof data !== 'object') throw new AiProviderError('invalid_response', 'Provider returned an unreadable response');
  let text = '';
  if (style === 'responses') {
    if (data.error) throw new AiProviderError('upstream', 'Provider reported an error');
    const messages = Array.isArray(data.output) ? data.output.filter((item) => item?.type === 'message') : [];
    text = messages.map((item) => textFromParts(item.content, 'output_text') || textFromParts(item.content, 'refusal')).join('');
    if (!text && typeof data.output_text === 'string') text = data.output_text;
  } else if (style === 'anthropic') {
    if (data.type === 'error') throw new AiProviderError('upstream', 'Provider reported an error');
    text = textFromParts(data.content, 'text');
  } else {
    const message = Array.isArray(data.choices) ? data.choices[0]?.message : null;
    text = message ? textFromParts(message.content, 'text') : '';
  }
  text = String(text || '').trim();
  if (!text) throw new AiProviderError('empty_response', 'The model returned no text');
  if (text.length > LIMITS.maxAssistantChars) text = `${text.slice(0, LIMITS.maxAssistantChars)}\n\n[response truncated]`;
  return { text, model: typeof data.model === 'string' && data.model.length <= 128 ? data.model : null };
};

const mapHttpError = (status) => {
  if (status === 401 || status === 403) return new AiProviderError('auth', 'The provider rejected the API key', { status });
  if (status === 404) return new AiProviderError('model_not_found', 'The provider does not know this model', { status });
  if (status === 429) return new AiProviderError('rate_limited', 'The provider is rate limiting this key', { status, retryable: true });
  if (status === 402) return new AiProviderError('billing', 'The provider reports a billing problem for this key', { status });
  if (status >= 400 && status < 500) return new AiProviderError('bad_request', 'The provider rejected the request', { status });
  return new AiProviderError('upstream', 'The provider is unavailable', { status, retryable: true });
};

const readBounded = async (response, maxBytes) => {
  const declared = parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isInteger(declared) && declared > maxBytes) throw new AiProviderError('response_too_large', 'Provider response is too large');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > maxBytes) throw new AiProviderError('response_too_large', 'Provider response is too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AiProviderError('response_too_large', 'Provider response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
};

// Single non-streaming completion. Returns { text, model }. Throws
// AiProviderError with a short, safe code/message; never rethrows raw
// provider payloads.
const complete = async ({ provider, model, apiKey, system, messages, maxTokens }, { fetchImpl = globalThis.fetch, timeoutMs = LIMITS.timeoutMs } = {}) => {
  if (!isValidProvider(provider)) throw new AiProviderError('not_configured', 'Unsupported provider');
  if (!isValidModel(model)) throw new AiProviderError('invalid_model', 'Set a valid model id in your AI settings');
  if (!isValidApiKey(apiKey)) throw new AiProviderError('not_configured', 'No usable API key is configured');
  const spec = PROVIDERS[provider];
  const request = buildRequest({ provider, model, apiKey, system, messages, maxTokens });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: 'error'
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new AiProviderError('timeout', 'The provider did not answer in time', { retryable: false });
    throw new AiProviderError('network', 'Could not reach the provider', { retryable: true });
  }

  let raw;
  try {
    raw = await readBounded(response, LIMITS.maxResponseBytes);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (controller.signal.aborted) throw new AiProviderError('timeout', 'The provider did not answer in time');
    throw new AiProviderError('network', 'Lost the connection to the provider', { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const error = mapHttpError(response.status);
    console.warn(`[AI] ${spec.label} request failed: status=${response.status} code=${error.code}`);
    throw error;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AiProviderError('invalid_response', 'Provider returned an unreadable response');
  }
  const parsed = parseResponse(spec.style, data);
  return { text: parsed.text, model: parsed.model || model };
};

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  LIMITS,
  AiProviderError,
  isValidProvider,
  isValidModel,
  isValidApiKey,
  normalizeTurns,
  buildRequest,
  parseResponse,
  complete
};
