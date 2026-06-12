#!/usr/bin/env node
// scripts/validate_topic_classification.mjs
// Judges embedding-based topic classification against an LLM.
// Runs on the HOST (needs reach to both docker psql and desktop:8004).
//   node scripts/validate_topic_classification.mjs [--sample 100]
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const SAMPLE = Number(process.argv[process.argv.indexOf('--sample') + 1]) || 100;
const QWEN_URL = process.env.QWEN_URL || 'http://desktop:8004';
const OPENROUTER_MODEL = process.env.VALIDATION_MODEL || 'google/gemma-4-26b-a4b-it:free';

const psql = (sql) =>
  execFileSync('docker', ['exec', 'intellacc_db', 'psql', '-U', 'intellacc_user', '-d', 'intellaccdb', '-t', '-A', '-F', '\t', '-c', sql], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t'));

const topics = psql(`SELECT id, slug, name FROM topics WHERE is_user_facing ORDER BY display_order`)
  .map(([id, slug, name]) => ({ id: Number(id), slug, name }));
const slugList = topics.map((t) => t.slug).join(', ');

const sample = psql(`
  SELECT e.id, REPLACE(LEFT(e.title, 300), E'\t', ' '), STRING_AGG(t.slug, ',')
  FROM events e JOIN event_topics et ON et.event_id = e.id JOIN topics t ON t.id = et.topic_id
  WHERE et.source = 'embedding'
  GROUP BY e.id ORDER BY random() LIMIT ${SAMPLE}
`).map(([id, title, slugs]) => ({ id: Number(id), title, assigned: slugs.split(',') }));

const prompt = (title) => `/no_think
You classify prediction-market questions into topics.
Allowed topic slugs: ${slugList}
Return exactly one JSON object: {"topics": ["slug", ...]} with 1-2 slugs, best first.
Question: ${JSON.stringify(title)}`;

const askQwen = async (title) => {
  const res = await fetch(`${QWEN_URL}/qwen-json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '', prompt: prompt(title), think: false, format: 'json', options: { temperature: 0, num_predict: 200 } })
  });
  if (!res.ok) throw new Error(`qwen ${res.status}`);
  const data = await res.json();
  const text = typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
  return JSON.parse(text).topics || [];
};

const askOpenRouter = async (title) => {
  const key = (readFileSync('backend/.env', 'utf8').match(/^OPENROUTER_API_KEY=(.*)$/m) || [])[1];
  if (!key) throw new Error('OPENROUTER_API_KEY not found in backend/.env');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.trim()}` },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt(title) }], temperature: 0 })
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const data = await res.json();
  const text = data.choices[0].message.content.replace(/```json|```/g, '').trim();
  return JSON.parse(text).topics || [];
};

let judge = askQwen, judgeName = 'qwen (local)';
try { await fetch(`${QWEN_URL}/health`).then((r) => { if (!r.ok) throw new Error(); }); }
catch { judge = askOpenRouter; judgeName = `openrouter:${OPENROUTER_MODEL}`; }
console.log(`Judge: ${judgeName}`);

let top1Match = 0, anyOverlap = 0, judged = 0;
const disagreements = [];
for (const ev of sample) {
  try {
    const llm = await judge(ev.title);
    judged += 1;
    if (llm[0] && ev.assigned[0] === llm[0]) top1Match += 1;
    if (llm.some((s) => ev.assigned.includes(s))) anyOverlap += 1;
    else disagreements.push({ id: ev.id, title: ev.title, embedding: ev.assigned, llm });
  } catch (err) {
    console.error(`event ${ev.id}: judge failed (${err.message})`);
  }
}

const total = Math.max(judged, 1);
const top1Pct = (100 * top1Match) / total;
const overlapPct = (100 * anyOverlap) / total;
const pct = (n) => n.toFixed(1);
const date = new Date().toISOString().slice(0, 10);
const reportsDir = 'docs/superpowers/reports';
mkdirSync(reportsDir, { recursive: true });
const report = `# Topic classification validation — ${date}

- Judge: ${judgeName}
- Sample judged: ${judged}/${sample.length}
- **Top-1 agreement: ${pct(top1Pct)}%**
- **Any-overlap agreement: ${pct(overlapPct)}%** (gate: ≥ 80%)
- Verdict: ${overlapPct >= 80 ? 'PASS — ship embedding classification' : 'FAIL — reconsider (LLM-at-import fallback)'}

## Disagreements (${disagreements.length})
${disagreements.map((d) => `- [${d.id}] "${d.title}" — embedding: ${d.embedding.join(',')} | llm: ${d.llm.join(',')}`).join('\n')}
`;
writeFileSync(`${reportsDir}/${date}-topic-validation.md`, report);
console.log(report);
