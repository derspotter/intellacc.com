const QWEN_URL = process.env.QWEN_URL || 'http://100.106.140.46:8004';
const QWEN_CLASSIFIER_RETRY_MS = () => Number(process.env.QWEN_CLASSIFIER_RETRY_MS) || 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildPrompt = (title, details, slugs) =>
  `/no_think You classify prediction-market questions into topics.\n` +
  `Allowed topic slugs: ${slugs.join(', ')}\n` +
  `Return exactly one JSON object: {"topics": ["slug", ...]} with 1-2 slugs, best first.\n` +
  `Question: ${JSON.stringify(String(title || '').slice(0, 300))}` +
  (details ? `\nDetails: ${JSON.stringify(String(details).slice(0, 500))}` : '');

const parseQwenResponse = (data) => {
  const text = data?.response;
  // With format:"json" the service may hand back an already-parsed object.
  if (text && typeof text === 'object') return Array.isArray(text.topics) ? text.topics : [];
  if (typeof text !== 'string') return [];
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]);
  return Array.isArray(parsed?.topics) ? parsed.topics : [];
};

const attemptClassify = async (prompt) => {
  const res = await fetch(`${QWEN_URL}/qwen-json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: '',
      prompt,
      think: false,
      format: 'json',
      options: { temperature: 0, num_predict: 120 }
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) {
    throw new Error(`Qwen service ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return parseQwenResponse(data);
};

const classifyWithQwen = async (title, details, slugs) => {
  const prompt = buildPrompt(title, details, slugs);
  try {
    return await attemptClassify(prompt);
  } catch (firstError) {
    await sleep(QWEN_CLASSIFIER_RETRY_MS());
    try {
      return await attemptClassify(prompt);
    } catch (secondError) {
      throw secondError;
    }
  }
};

module.exports = { classifyWithQwen };
