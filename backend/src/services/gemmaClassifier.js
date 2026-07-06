// Topic classification via the local Gemma model on the Mac mini
// (OpenAI-compatible llama.cpp server). Replaces the previous Qwen
// service-manager classifier. The same call also returns a junk verdict used
// to hide unserious/match-betting markets.
//
// Env:
//   GEMMA_URL     - OpenAI-compatible base URL (…/v1). Default targets the
//                   Mac mini tailnet IP because the backend container cannot
//                   resolve magicDNS names (only the IP).
//   GEMMA_MODEL   - model id served by the endpoint.
//   GEMMA_API_KEY - bearer token (kept in the gitignored root .env, never code).
const GEMMA_URL = (process.env.GEMMA_URL || 'http://100.111.127.90:8011/v1').replace(/\/$/, '');
const GEMMA_MODEL = process.env.GEMMA_MODEL || 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf';
const GEMMA_API_KEY = process.env.GEMMA_API_KEY || '';
const GEMMA_CLASSIFIER_RETRY_MS = () => Number(process.env.GEMMA_CLASSIFIER_RETRY_MS) || 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildPrompt = (title, details, slugs) =>
  `You classify prediction-market questions into topics and screen out junk.\n` +
  `Allowed topic slugs: ${slugs.join(', ')}\n` +
  `A question is junk if it is ANY of:\n` +
  `- an unserious/joke/meme market;\n` +
  `- a religious-prophecy or supernatural market (rapture, second coming, divine ` +
  `intervention, miracles, end-times);\n` +
  `- a market about the prediction platform HOSTING it (Manifold, Metaculus, ` +
  `Intellacc: its own prices/community predictions, user counts, mana, users, ` +
  `moderation) or the author's personal life, goals or relationships;\n` +
  `- a subjective question that defines no objective resolution criteria (check ` +
  `the details before deciding);\n` +
  `- a sports-betting market on an individual regular match, game, race or fight ` +
  `outcome (e.g. "Will X beat Y", "Will X win <specific game/race>").\n` +
  `NOT junk: league/season/tournament CHAMPIONS (Scudetto, Super Bowl, World Cup ` +
  `winners); substantive sports questions (league policy, host-city decisions, ` +
  `doping rulings, season records); factual religion news (papal visits, church ` +
  `decisions, demographics); questions about external websites, companies or ` +
  `software other than the hosting platform.\n` +
  `Return exactly one JSON object: ` +
  `{"topics": ["slug", ...], "junk": true|false, "junk_reason": "<short reason, empty if not junk>"} ` +
  `with 1-2 slugs, best first.\n` +
  `Question: ${JSON.stringify(String(title || '').slice(0, 300))}` +
  (details ? `\nDetails: ${JSON.stringify(String(details).slice(0, 500))}` : '');

// Returns { topics: string[], junk: boolean|null, junkReason: string|null }.
// junk is null when the model omitted the field or returned a non-boolean —
// callers treat that as "no verdict", not "not junk".
const parseGemmaResponse = (data) => {
  const empty = { topics: [], junk: null, junkReason: null };
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return empty;
  // Strip optional code fences and isolate the JSON object.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  const parsed = JSON.parse(match[0]);
  return {
    topics: Array.isArray(parsed?.topics) ? parsed.topics : [],
    junk: typeof parsed?.junk === 'boolean' ? parsed.junk : null,
    junkReason: typeof parsed?.junk_reason === 'string' ? parsed.junk_reason.trim() || null : null
  };
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
      max_tokens: 160,
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
