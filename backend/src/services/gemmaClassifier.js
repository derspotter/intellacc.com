// Topic classification via the local Gemma model on debian (OpenAI-compatible
// llama.cpp server). Replaces the previous Qwen service-manager classifier.
//
// Env:
//   GEMMA_URL     - OpenAI-compatible base URL (…/v1). Default targets the
//                   debian tailnet IP because the backend container cannot
//                   resolve the `debian` magicDNS name (only the IP).
//   GEMMA_MODEL   - model id served by the endpoint.
//   GEMMA_API_KEY - bearer token (kept in the gitignored root .env, never code).
const GEMMA_URL = (process.env.GEMMA_URL || 'http://100.119.163.1:8011/v1').replace(/\/$/, '');
const GEMMA_MODEL = process.env.GEMMA_MODEL || 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf';
const GEMMA_API_KEY = process.env.GEMMA_API_KEY || '';
const GEMMA_CLASSIFIER_RETRY_MS = () => Number(process.env.GEMMA_CLASSIFIER_RETRY_MS) || 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildPrompt = (title, details, slugs) =>
  `You classify prediction-market questions into topics.\n` +
  `Allowed topic slugs: ${slugs.join(', ')}\n` +
  `Return exactly one JSON object: {"topics": ["slug", ...]} with 1-2 slugs, best first.\n` +
  `Question: ${JSON.stringify(String(title || '').slice(0, 300))}` +
  (details ? `\nDetails: ${JSON.stringify(String(details).slice(0, 500))}` : '');

const parseGemmaResponse = (data) => {
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return [];
  // Strip optional code fences and isolate the JSON object.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]);
  return Array.isArray(parsed?.topics) ? parsed.topics : [];
};

const attemptClassify = async (prompt) => {
  const res = await fetch(`${GEMMA_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GEMMA_API_KEY ? { Authorization: `Bearer ${GEMMA_API_KEY}` } : {})
    },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 120,
      // Gemma's chat template enables reasoning by default; disable it so the
      // model answers with JSON directly instead of a think block.
      chat_template_kwargs: { enable_thinking: false }
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) {
    throw new Error(`Gemma service ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return parseGemmaResponse(data);
};

const classifyWithGemma = async (title, details, slugs) => {
  const prompt = buildPrompt(title, details, slugs);
  try {
    return await attemptClassify(prompt);
  } catch (firstError) {
    await sleep(GEMMA_CLASSIFIER_RETRY_MS());
    return attemptClassify(prompt);
  }
};

module.exports = { classifyWithGemma };
