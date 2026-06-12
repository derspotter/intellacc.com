# Topic Onboarding, Periodic Questions & Predictor Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users pick ≥3 topics at login (blocking), get topic-matched weekly prediction assignments, and an empty following-feed falls back to posts by top predictors in their topics.

**Architecture:** Pure Postgres/pgvector classification (event embedding ↔ topic embedding cosine similarity) with an LLM validation gate before rollout. All backend work is small deltas on existing services (`weeklyAssignmentService`, `postController` feed machinery, network-graph accuracy SQL). Frontend gate lives in `VanApp` ahead of page rendering.

**Tech Stack:** Express + pg + pgvector, OpenRouter embeddings (existing `openRouterMatcher/embeddingService`), local Qwen via `http://desktop:8004` (judge), SolidJS frontend, jest + supertest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-12-topic-onboarding-design.md`

**Conventions used below:**
- Backend tests run inside the container: `docker exec intellacc_backend npx jest test/<file> --runInBand`
- DB access: `docker exec intellacc_db psql -U intellacc_user -d intellaccdb`
- The backend auto-runs `backend/migrations/*.sql` on container start; migrations must be idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`) because CI replays them onto an initialized DB.

---

### Task 1: Migration — topic tables + seed topics

**Files:**
- Create: `backend/migrations/add_topic_system.sql`

- [ ] **Step 1: Write the migration**

```sql
-- backend/migrations/add_topic_system.sql
-- Topic system: user-facing topics, event classification, user preferences.
-- Idempotent: safe to replay.

ALTER TABLE topics ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS embedding vector(768);
ALTER TABLE topics ADD COLUMN IF NOT EXISTS is_user_facing BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS display_order INT;

CREATE UNIQUE INDEX IF NOT EXISTS topics_slug_key ON topics (slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_topics (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    similarity REAL,
    source TEXT NOT NULL DEFAULT 'embedding',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_event_topics_topic ON event_topics (topic_id);

CREATE TABLE IF NOT EXISTS user_topics (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_user_topics_topic ON user_topics (topic_id);

INSERT INTO topics (name, slug, description, is_user_facing, display_order) VALUES
('Politics', 'politics', 'Domestic politics: elections, legislation, party leadership, polling, government formation. Example questions: Who wins the next election? Will this bill pass?', TRUE, 1),
('Geopolitics', 'geopolitics', 'International relations, conflicts, diplomacy, treaties, sanctions, territorial disputes. Example questions: Will a ceasefire hold? Will country X join the alliance?', TRUE, 2),
('Economics & Finance', 'economics-finance', 'Macroeconomics, markets, inflation, interest rates, employment, recessions, corporate earnings. Example questions: Will the central bank cut rates? Will GDP growth exceed 2%?', TRUE, 3),
('AI & Technology', 'ai-technology', 'Artificial intelligence, software, hardware, space tech, consumer technology, tech companies. Example questions: Will an AI model pass this benchmark? Will the product launch this year?', TRUE, 4),
('Science', 'science', 'Scientific research and discoveries: physics, biology, medicine research, mathematics, peer-reviewed results. Example questions: Will the experiment replicate? Will the mission detect what it searches for?', TRUE, 5),
('Climate & Environment', 'climate-environment', 'Climate change, emissions, extreme weather, energy transition, environmental policy. Example questions: Will this year be the hottest on record? Will the emissions target be met?', TRUE, 6),
('Health', 'health', 'Public health, pandemics, drug approvals, healthcare policy, epidemiology. Example questions: Will the vaccine be approved? Will cases exceed the threshold?', TRUE, 7),
('Sports', 'sports', 'Professional and international sports: football, basketball, olympics, championships, transfers and records. Example questions: Who wins the championship? Will the record be broken?', TRUE, 8),
('Culture & Media', 'culture-media', 'Film, music, awards, celebrities, social media trends, publishing. Example questions: Which film wins the award? Will the show be renewed?', TRUE, 9),
('Crypto', 'crypto', 'Cryptocurrencies, blockchain, token prices, exchanges, crypto regulation. Example questions: Will bitcoin close above the threshold? Will the ETF be approved?', TRUE, 10)
ON CONFLICT DO NOTHING;

-- Replays: ON CONFLICT needs a unique target; name has no constraint, so guard
-- against duplicates explicitly for reruns where slugs already exist.
DELETE FROM topics a USING topics b
WHERE a.id > b.id AND a.slug = b.slug AND a.slug IS NOT NULL;
```

- [ ] **Step 2: Apply and verify**

Run: `docker restart intellacc_backend && sleep 20 && docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT slug FROM topics WHERE is_user_facing ORDER BY display_order;" -c "\d user_topics" -c "\d event_topics"`
Expected: 10 slugs (politics … crypto); both tables exist.

- [ ] **Step 3: Verify replayability**

Run: `docker exec intellacc_backend node -e "require('./src/db');" && docker restart intellacc_backend && sleep 20 && docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT count(*) FROM topics WHERE is_user_facing;"`
Expected: still exactly 10 (no duplicate seeds after second run).

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/add_topic_system.sql
git commit -m "feat(topics): migration for topic system (topics ext, event_topics, user_topics, seed)"
```

---

### Task 2: `topicService` — embeddings + event classification

**Files:**
- Create: `backend/src/services/topicService.js`
- Test: `backend/test/topic_classification.test.js`

- [ ] **Step 1: Write the failing test**

The test inserts two topics with orthogonal synthetic embeddings and an event near one of them, then expects classification to pick the close topic. Helper builds a 768-dim vector literal.

```js
// backend/test/topic_classification.test.js
const db = require('../src/db');
const topicService = require('../src/services/topicService');

jest.setTimeout(30000);

const vec = (hotIndex) => {
  const v = new Array(768).fill(0);
  v[hotIndex] = 1;
  return `[${v.join(',')}]`;
};

describe('topicService.classifyEvent', () => {
  const cleanup = { topicIds: [], eventIds: [] };

  afterAll(async () => {
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
  });

  test('assigns the nearest user-facing topic; adds second only within margin', async () => {
    const t1 = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing, embedding) VALUES ('TestTopicA', 'test-topic-a-' || floor(random()*1e9), TRUE, $1::vector) RETURNING id`,
      [vec(0)]
    );
    const t2 = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing, embedding) VALUES ('TestTopicB', 'test-topic-b-' || floor(random()*1e9), TRUE, $1::vector) RETURNING id`,
      [vec(1)]
    );
    cleanup.topicIds.push(t1.rows[0].id, t2.rows[0].id);

    const ev = await db.query(
      `INSERT INTO events (title, closing_date, embedding) VALUES ('classify me', NOW() + INTERVAL '30 days', $1::vector) RETURNING id`,
      [vec(0)]
    );
    cleanup.eventIds.push(ev.rows[0].id);

    const assigned = await topicService.classifyEvent(ev.rows[0].id);
    expect(assigned.map((a) => a.topic_id)).toContain(t1.rows[0].id);
    expect(assigned.map((a) => a.topic_id)).not.toContain(t2.rows[0].id);

    const rows = await db.query('SELECT topic_id, source FROM event_topics WHERE event_id = $1', [ev.rows[0].id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].source).toBe('embedding');
  });

  test('returns empty array for event without embedding', async () => {
    const ev = await db.query(
      `INSERT INTO events (title, closing_date) VALUES ('no embedding', NOW() + INTERVAL '30 days') RETURNING id`
    );
    cleanup.eventIds.push(ev.rows[0].id);
    const assigned = await topicService.classifyEvent(ev.rows[0].id);
    expect(assigned).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec intellacc_backend npx jest test/topic_classification.test.js --runInBand`
Expected: FAIL — `Cannot find module '../src/services/topicService'`

- [ ] **Step 3: Implement `topicService`**

```js
// backend/src/services/topicService.js
const db = require('../db');
const { embedText } = require('./openRouterMatcher/embeddingService');

// A second topic is also assigned when its cosine similarity is within this
// margin of the best topic (events often straddle two topics).
const SECOND_TOPIC_MARGIN = 0.05;

// Generate embeddings for user-facing topics that don't have one yet.
const embedMissingTopicEmbeddings = async () => {
  const result = await db.query(
    `SELECT id, name, description FROM topics WHERE is_user_facing = TRUE AND embedding IS NULL`
  );
  let embedded = 0;
  for (const row of result.rows) {
    const embedding = await embedText(`${row.name}. ${row.description || ''}`);
    await db.query(`UPDATE topics SET embedding = $1::vector WHERE id = $2`, [
      `[${embedding.map(Number).join(',')}]`,
      row.id
    ]);
    embedded += 1;
  }
  return embedded;
};

// Classify one event into 1-2 user-facing topics by embedding similarity.
// Replaces any previous 'embedding'-sourced rows; returns assigned rows.
const classifyEvent = async (eventId) => {
  const id = Number(eventId);
  if (!Number.isInteger(id)) throw new Error('Invalid event id');

  const result = await db.query(
    `WITH ranked AS (
       SELECT t.id AS topic_id,
              (1 - (e.embedding <=> t.embedding))::REAL AS similarity,
              ROW_NUMBER() OVER (ORDER BY e.embedding <=> t.embedding ASC) AS rank
       FROM events e
       CROSS JOIN topics t
       WHERE e.id = $1
         AND e.embedding IS NOT NULL
         AND t.is_user_facing = TRUE
         AND t.embedding IS NOT NULL
     ),
     chosen AS (
       SELECT topic_id, similarity FROM ranked
       WHERE rank = 1
          OR (rank = 2 AND similarity >= (SELECT similarity FROM ranked WHERE rank = 1) - $2)
     ),
     cleared AS (
       DELETE FROM event_topics WHERE event_id = $1 AND source = 'embedding'
     )
     INSERT INTO event_topics (event_id, topic_id, similarity, source)
     SELECT $1, topic_id, similarity, 'embedding' FROM chosen
     ON CONFLICT (event_id, topic_id)
       DO UPDATE SET similarity = EXCLUDED.similarity, source = EXCLUDED.source
     RETURNING topic_id, similarity`,
    [id, SECOND_TOPIC_MARGIN]
  );
  return result.rows;
};

// Classify all events that have an embedding but no embedding-sourced topics.
const classifyUnclassifiedEvents = async () => {
  const result = await db.query(
    `SELECT e.id FROM events e
     WHERE e.embedding IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM event_topics et WHERE et.event_id = e.id AND et.source = 'embedding'
       )`
  );
  let classified = 0;
  for (const row of result.rows) {
    const assigned = await classifyEvent(row.id);
    if (assigned.length > 0) classified += 1;
  }
  return classified;
};

module.exports = { embedMissingTopicEmbeddings, classifyEvent, classifyUnclassifiedEvents, SECOND_TOPIC_MARGIN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec intellacc_backend npx jest test/topic_classification.test.js --runInBand`
Expected: PASS (2 tests)

- [ ] **Step 5: Hook classification into event creation**

In `backend/src/controllers/predictionsController.js` (the existing `setEventEmbedding` fire-and-forget call around line 367), classify after embedding completes:

```js
// Replace the existing fire-and-forget:
//   setEventEmbedding({ eventId: ..., title: ..., details: ... })
// with embedding followed by classification (still fire-and-forget):
setEventEmbedding({
  eventId: newEvent.id,
  title: newEvent.title,
  details: newEvent.details
})
  .then(() => topicService.classifyEvent(newEvent.id))
  .catch((error) => console.error('[Topics] Failed to classify new event', newEvent.id, error.message));
```

(Adapt the exact variable names to the surrounding code at `predictionsController.js:367`; add `const topicService = require('../services/topicService');` at the top. Keep the existing `.catch` if one exists — the requirement is: embedding errors and classification errors must be logged, never thrown into the request path.)

- [ ] **Step 6: Run the full backend suite, then commit**

Run: `docker exec intellacc_backend npm test`
Expected: all suites pass.

```bash
git add backend/src/services/topicService.js backend/test/topic_classification.test.js backend/src/controllers/predictionsController.js
git commit -m "feat(topics): embedding-based event classification service"
```

---

### Task 3: Backfill script — event embeddings + classification

**Files:**
- Create: `backend/src/scripts/backfillTopics.js`

- [ ] **Step 1: Write the script**

```js
// backend/src/scripts/backfillTopics.js
// One-shot, idempotent: embed topics, embed events missing embeddings,
// classify all unclassified events. Run inside the backend container:
//   docker exec intellacc_backend node src/scripts/backfillTopics.js
const db = require('../db');
const { backfillEmbeddings } = require('../services/openRouterMatcher/embeddingService');
const topicService = require('../services/topicService');

const main = async () => {
  console.log('[backfill] embedding user-facing topics…');
  const topicsEmbedded = await topicService.embedMissingTopicEmbeddings();
  console.log(`[backfill] topics embedded: ${topicsEmbedded}`);

  console.log('[backfill] embedding events without embeddings…');
  await backfillEmbeddings(); // existing service; logs failures per event

  console.log('[backfill] classifying events…');
  const classified = await topicService.classifyUnclassifiedEvents();
  console.log(`[backfill] events classified: ${classified}`);

  const stats = await db.query(
    `SELECT t.slug, COUNT(et.event_id) AS events
     FROM topics t LEFT JOIN event_topics et ON et.topic_id = t.id
     WHERE t.is_user_facing GROUP BY t.slug ORDER BY events DESC`
  );
  console.table(stats.rows);
  process.exit(0);
};

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it against prod data**

Run: `docker exec intellacc_backend node src/scripts/backfillTopics.js`
Expected: `topics embedded: 10`, then per-topic event counts. ~605 events need fresh embeddings via OpenRouter — this takes a while and may log individual failures (acceptable; rerun is idempotent).

- [ ] **Step 3: Sanity-check distribution**

Run: `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT t.slug, count(*) FROM event_topics et JOIN topics t ON t.id = et.topic_id GROUP BY t.slug ORDER BY 2 DESC;" -c "SELECT count(*) FROM events WHERE embedding IS NOT NULL;"`
Expected: every classified event has 1–2 topics; no topic hogging >50% of events (if one does, note it for the validation report).

- [ ] **Step 4: Commit**

```bash
git add backend/src/scripts/backfillTopics.js
git commit -m "feat(topics): idempotent embedding + classification backfill script"
```

---

### Task 4: Validation harness + GATE (STOP for review)

**Files:**
- Create: `scripts/validate_topic_classification.mjs` (host-side, zero npm deps)
- Output: `docs/superpowers/reports/2026-06-DD-topic-validation.md`

- [ ] **Step 1: Write the harness**

```js
#!/usr/bin/env node
// scripts/validate_topic_classification.mjs
// Judges embedding-based topic classification against an LLM.
// Runs on the HOST (needs reach to both docker psql and desktop:8004).
//   node scripts/validate_topic_classification.mjs [--sample 100]
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

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

const pct = (n) => ((100 * n) / Math.max(judged, 1)).toFixed(1);
const date = new Date().toISOString().slice(0, 10);
const report = `# Topic classification validation — ${date}

- Judge: ${judgeName}
- Sample judged: ${judged}/${sample.length}
- **Top-1 agreement: ${pct(top1Match)}%**
- **Any-overlap agreement: ${pct(anyOverlap)}%** (gate: ≥ 80%)
- Verdict: ${pct(anyOverlap) >= 80 ? 'PASS — ship embedding classification' : 'FAIL — reconsider (LLM-at-import fallback)'}

## Disagreements (${disagreements.length})
${disagreements.map((d) => `- [${d.id}] "${d.title}" — embedding: ${d.embedding.join(',')} | llm: ${d.llm.join(',')}`).join('\n')}
`;
writeFileSync(`docs/superpowers/reports/${date}-topic-validation.md`, report);
console.log(report);
```

- [ ] **Step 2: Run the harness**

Run: `mkdir -p docs/superpowers/reports && node scripts/validate_topic_classification.mjs --sample 100`
Expected: report printed and written; Qwen used as judge (the manager at `desktop:8004` was healthy at design time).

- [ ] **Step 3: GATE — STOP and show the report to Justus**

**Do not proceed to Task 5 until Justus has read the report and approved.** If any-overlap < 80%: stop the plan, return to design (likely switching `event_topics.source` to `'llm'` writes at import).

- [ ] **Step 4: Commit harness + report**

```bash
git add scripts/validate_topic_classification.mjs docs/superpowers/reports/
git commit -m "feat(topics): LLM validation harness + agreement report"
```

---

### Task 5: Topics API — list + own preferences

**Files:**
- Create: `backend/src/controllers/topicsController.js`
- Modify: `backend/src/routes/api.js` (router section near the other `router.get` blocks)
- Test: `backend/test/topics_api.test.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/test/topics_api.test.js
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: row.rows[0].id, username, token: loginRes.body.token };
};

describe('Topics API', () => {
  const cleanup = { userIds: [] };
  afterAll(async () => {
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('GET /api/topics lists only user-facing topics in display order', async () => {
    const res = await request(app).get('/api/topics');
    expect(res.statusCode).toBe(200);
    expect(res.body.topics.length).toBeGreaterThanOrEqual(10);
    const slugs = res.body.topics.map((t) => t.slug);
    expect(slugs).toContain('politics');
    expect(slugs).not.toContain(null);
    expect(res.body.topics[0]).toHaveProperty('name');
    expect(res.body.topics[0]).not.toHaveProperty('embedding');
  });

  test('PUT /api/users/me/topics requires >= 3 topics and persists', async () => {
    const user = await createUser('topicuser');
    cleanup.userIds.push(user.id);

    const topicsRes = await request(app).get('/api/topics');
    const ids = topicsRes.body.topics.slice(0, 3).map((t) => t.id);

    const tooFew = await request(app)
      .put('/api/users/me/topics')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ topicIds: ids.slice(0, 2) });
    expect(tooFew.statusCode).toBe(400);

    const ok = await request(app)
      .put('/api/users/me/topics')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ topicIds: ids });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.topicIds.sort()).toEqual(ids.sort());

    const get = await request(app)
      .get('/api/users/me/topics')
      .set('Authorization', `Bearer ${user.token}`);
    expect(get.statusCode).toBe(200);
    expect(get.body.topicIds.sort()).toEqual(ids.sort());
  });

  test('PUT replaces the previous set and rejects unknown ids', async () => {
    const user = await createUser('topicuser2');
    cleanup.userIds.push(user.id);
    const topicsRes = await request(app).get('/api/topics');
    const all = topicsRes.body.topics.map((t) => t.id);

    await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: all.slice(0, 3) });
    const second = await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: all.slice(1, 4) });
    expect(second.statusCode).toBe(200);
    expect(second.body.topicIds.sort()).toEqual(all.slice(1, 4).sort());

    const bad = await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`).send({ topicIds: [999999, 999998, 999997] });
    expect(bad.statusCode).toBe(400);
  });

  test('GET/PUT me/topics require auth', async () => {
    expect((await request(app).get('/api/users/me/topics')).statusCode).toBe(401);
    expect((await request(app).put('/api/users/me/topics').send({ topicIds: [1, 2, 3] })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec intellacc_backend npx jest test/topics_api.test.js --runInBand`
Expected: FAIL with 404s (routes don't exist).

- [ ] **Step 3: Implement the controller**

```js
// backend/src/controllers/topicsController.js
const db = require('../db');

const MIN_TOPICS = 3;

exports.listTopics = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, slug, name, description, display_order
       FROM topics WHERE is_user_facing = TRUE
       ORDER BY display_order NULLS LAST, id`
    );
    res.json({ topics: result.rows });
  } catch (err) {
    console.error('Error listing topics:', err);
    res.status(500).json({ message: 'Failed to list topics' });
  }
};

exports.getMyTopics = async (req, res) => {
  try {
    const result = await db.query('SELECT topic_id FROM user_topics WHERE user_id = $1', [req.user.id]);
    res.json({ topicIds: result.rows.map((r) => r.topic_id) });
  } catch (err) {
    console.error('Error fetching user topics:', err);
    res.status(500).json({ message: 'Failed to fetch topics' });
  }
};

exports.setMyTopics = async (req, res) => {
  const topicIds = Array.isArray(req.body?.topicIds)
    ? [...new Set(req.body.topicIds.map(Number).filter(Number.isInteger))]
    : [];
  if (topicIds.length < MIN_TOPICS) {
    return res.status(400).json({ message: `Pick at least ${MIN_TOPICS} topics` });
  }

  const client = await db.getPool().connect();
  try {
    const valid = await client.query(
      'SELECT id FROM topics WHERE is_user_facing = TRUE AND id = ANY($1::int[])',
      [topicIds]
    );
    if (valid.rows.length !== topicIds.length) {
      return res.status(400).json({ message: 'Unknown topic id' });
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM user_topics WHERE user_id = $1', [req.user.id]);
    await client.query(
      `INSERT INTO user_topics (user_id, topic_id)
       SELECT $1, UNNEST($2::int[])`,
      [req.user.id, topicIds]
    );
    await client.query('COMMIT');
    res.json({ topicIds });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error setting user topics:', err);
    res.status(500).json({ message: 'Failed to set topics' });
  } finally {
    client.release();
  }
};
```

- [ ] **Step 4: Register routes in `backend/src/routes/api.js`**

Next to the other user routes (require the controller at the top with its siblings):

```js
const topicsController = require('../controllers/topicsController');
// …
router.get('/topics', topicsController.listTopics);                                  // Public: topic list for picker
router.get('/users/me/topics', authenticateJWT, topicsController.getMyTopics);       // Own topic preferences
router.put('/users/me/topics', authenticateJWT, topicsController.setMyTopics);       // Replace own topic set (>=3)
```

**Route-order caution:** `/users/me/topics` must be registered BEFORE any `/users/:id/...` pattern that could shadow `me` — check the surrounding file and place it above parameterized user routes.

- [ ] **Step 5: Run test to verify it passes**

Run: `docker exec intellacc_backend npx jest test/topics_api.test.js --runInBand`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/topicsController.js backend/src/routes/api.js backend/test/topics_api.test.js
git commit -m "feat(topics): topics list + user topic preference endpoints"
```

---

### Task 6: Discover API — top predictors + discover feed

**Files:**
- Create: `backend/src/controllers/discoverController.js`
- Modify: `backend/src/routes/api.js`
- Test: `backend/test/discover_api.test.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/test/discover_api.test.js
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: row.rows[0].id, username, token: loginRes.body.token };
};

// Insert a resolved prediction for user on event (outcome 'correct'/'incorrect')
const addResolvedPrediction = (userId, eventId, outcome) =>
  db.query(
    `INSERT INTO predictions (user_id, event_id, event, prediction_value, confidence, outcome, resolved_at)
     VALUES ($1, $2, 'test', 'yes', 60, $3, NOW())
     ON CONFLICT (user_id, event_id) DO UPDATE SET outcome = $3, resolved_at = NOW()`,
    [userId, eventId, outcome]
  );

describe('Discover API', () => {
  const cleanup = { userIds: [], eventIds: [], topicIds: [], postIds: [] };
  let viewer, ace, dud, topicId;

  beforeAll(async () => {
    viewer = await createUser('discviewer');
    ace = await createUser('discace');
    dud = await createUser('discdud');
    cleanup.userIds.push(viewer.id, ace.id, dud.id);

    const t = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing) VALUES ('DiscTest', 'disc-test-' || floor(random()*1e9), TRUE) RETURNING id`
    );
    topicId = t.rows[0].id;
    cleanup.topicIds.push(topicId);

    // viewer picks ONLY this topic (plus 2 padding topics to satisfy >=3)
    const pad = await db.query(`SELECT id FROM topics WHERE is_user_facing AND id <> $1 LIMIT 2`, [topicId]);
    await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${viewer.token}`)
      .send({ topicIds: [topicId, ...pad.rows.map((r) => r.id)] });

    // 5 resolved events in the topic; ace 5/5 correct, dud 1/5 correct
    for (let i = 0; i < 5; i++) {
      const ev = await db.query(
        `INSERT INTO events (title, closing_date, outcome) VALUES ('disc ev ' || $1, NOW() - INTERVAL '1 day', 'yes') RETURNING id`, [i]
      );
      const eventId = ev.rows[0].id;
      cleanup.eventIds.push(eventId);
      await db.query(`INSERT INTO event_topics (event_id, topic_id, source) VALUES ($1, $2, 'test')`, [eventId, topicId]);
      await addResolvedPrediction(ace.id, eventId, 'correct');
      await addResolvedPrediction(dud.id, eventId, i === 0 ? 'correct' : 'incorrect');
    }

    const post = await db.query(
      `INSERT INTO posts (user_id, content) VALUES ($1, 'ace says markets are great') RETURNING id`, [ace.id]
    );
    cleanup.postIds.push(post.rows[0].id);
  });

  afterAll(async () => {
    if (cleanup.postIds.length) await db.query('DELETE FROM posts WHERE id = ANY($1::int[])', [cleanup.postIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('predictors ranks in-topic accuracy, applies min-5 rule, excludes self', async () => {
    const res = await request(app).get('/api/discover/predictors').set('Authorization', `Bearer ${viewer.token}`);
    expect(res.statusCode).toBe(200);
    const ids = res.body.predictors.map((p) => p.id);
    expect(ids).toContain(ace.id);
    expect(ids).not.toContain(viewer.id);
    const aceRow = res.body.predictors.find((p) => p.id === ace.id);
    const dudRow = res.body.predictors.find((p) => p.id === dud.id);
    expect(Number(aceRow.accuracy_percent)).toBe(100);
    if (dudRow) expect(ids.indexOf(ace.id)).toBeLessThan(ids.indexOf(dud.id));
  });

  test('discover feed returns posts authored by top predictors', async () => {
    const res = await request(app).get('/api/discover/feed').set('Authorization', `Bearer ${viewer.token}`);
    expect(res.statusCode).toBe(200);
    const authors = res.body.items.map((p) => p.user_id);
    expect(authors).toContain(ace.id);
    const acePost = res.body.items.find((p) => p.user_id === ace.id);
    expect(acePost).toHaveProperty('username');
    expect(acePost).toHaveProperty('like_count');
  });

  test('requires auth', async () => {
    expect((await request(app).get('/api/discover/predictors')).statusCode).toBe(401);
    expect((await request(app).get('/api/discover/feed')).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec intellacc_backend npx jest test/discover_api.test.js --runInBand`
Expected: FAIL with 404s.

- [ ] **Step 3: Implement the controller**

```js
// backend/src/controllers/discoverController.js
const db = require('../db');

const MIN_RESOLVED_IN_TOPIC = 5;
const PREDICTOR_LIMIT = 10;
const FEED_LIMIT = 20;

// Top predictors across the caller's topics: in-topic accuracy with a
// min-resolved threshold, padded with globally accurate users when sparse.
// Excludes the caller and users they already follow.
const topPredictorsFor = async (userId) => {
  const result = await db.query(
    `WITH my_topics AS (
       SELECT topic_id FROM user_topics WHERE user_id = $1
     ),
     excluded AS (
       SELECT following_id AS id FROM follows WHERE follower_id = $1
       UNION SELECT $1
     ),
     in_topic AS (
       SELECT p.user_id,
              COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) AS resolved,
              100.0 * COUNT(*) FILTER (WHERE LOWER(COALESCE(p.outcome, '')) = 'correct')
                / NULLIF(COUNT(*) FILTER (WHERE p.outcome IS NOT NULL), 0) AS accuracy_percent
       FROM predictions p
       JOIN event_topics et ON et.event_id = p.event_id
       JOIN my_topics mt ON mt.topic_id = et.topic_id
       GROUP BY p.user_id
       HAVING COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) >= $2
     ),
     global_acc AS (
       SELECT p.user_id,
              COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) AS resolved,
              100.0 * COUNT(*) FILTER (WHERE LOWER(COALESCE(p.outcome, '')) = 'correct')
                / NULLIF(COUNT(*) FILTER (WHERE p.outcome IS NOT NULL), 0) AS accuracy_percent
       FROM predictions p
       GROUP BY p.user_id
       HAVING COUNT(*) FILTER (WHERE p.outcome IS NOT NULL) >= $2
     ),
     ranked AS (
       SELECT user_id, accuracy_percent, resolved, 0 AS tier FROM in_topic
       UNION ALL
       SELECT user_id, accuracy_percent, resolved, 1 AS tier FROM global_acc
       WHERE user_id NOT IN (SELECT user_id FROM in_topic)
     )
     SELECT u.id, u.username,
            ROUND(r.accuracy_percent::NUMERIC, 1)::DOUBLE PRECISION AS accuracy_percent,
            r.resolved::INT AS resolved_predictions,
            r.tier
     FROM ranked r
     JOIN users u ON u.id = r.user_id
     WHERE u.deleted_at IS NULL
       AND u.id NOT IN (SELECT id FROM excluded)
     ORDER BY r.tier ASC, r.accuracy_percent DESC, r.resolved DESC
     LIMIT $3`,
    [userId, MIN_RESOLVED_IN_TOPIC, PREDICTOR_LIMIT]
  );
  return result.rows;
};

exports.getPredictors = async (req, res) => {
  try {
    res.json({ predictors: await topPredictorsFor(req.user.id) });
  } catch (err) {
    console.error('Error fetching discover predictors:', err);
    res.status(500).json({ message: 'Failed to fetch predictors' });
  }
};

exports.getFeed = async (req, res) => {
  try {
    const predictors = await topPredictorsFor(req.user.id);
    if (predictors.length === 0) return res.json({ items: [], predictors: [] });

    const result = await db.query(
      `SELECT p.*, u.username, u.avatar_url,
              CASE WHEN EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1)
                   THEN true ELSE false END AS liked_by_user
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id = ANY($2::int[])
         AND p.parent_id IS NULL
         AND p.is_comment = FALSE
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $3`,
      [req.user.id, predictors.map((p) => p.id), FEED_LIMIT]
    );
    res.json({ items: result.rows, predictors });
  } catch (err) {
    console.error('Error fetching discover feed:', err);
    res.status(500).json({ message: 'Failed to fetch discover feed' });
  }
};
```

**Note on the feed SELECT:** the full following-feed query in `postController.getFeed` includes link metadata, AI flags, repost hydration, and visibility clauses. Discover mode deliberately uses a slimmer SELECT (YAGNI) — but it MUST include the post-visibility clause if `buildPostVisibilityClause` from `postController` filters private posts. Check `backend/src/controllers/postController.js` for `buildPostVisibilityClause` and add `AND ${buildPostVisibilityClause('$1')}` (export it from postController if not already exported) so private/hidden posts don't leak.

- [ ] **Step 4: Register routes**

```js
const discoverController = require('../controllers/discoverController');
// …
router.get('/discover/predictors', authenticateJWT, discoverController.getPredictors); // Top predictors in caller's topics
router.get('/discover/feed', authenticateJWT, discoverController.getFeed);             // Posts by those predictors
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker exec intellacc_backend npx jest test/discover_api.test.js --runInBand`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/discoverController.js backend/src/routes/api.js backend/test/discover_api.test.js
git commit -m "feat(discover): top-predictor ranking and discover feed endpoints"
```

---

### Task 7: Weekly assignments — eligibility fix + topic-aware selection

**Files:**
- Modify: `backend/src/services/weeklyAssignmentService.js` (`assignWeeklyPredictions`, ~lines 63–110)
- Test: `backend/test/weekly_topic_assignment.test.js`

**Diagnosis baked in:** prod has zero assignments ever because the user query filters `id IN (SELECT DISTINCT user_id FROM market_updates)` — only 4 rows exist in `market_updates`. Fix: eligibility becomes "user has completed topic onboarding" (`user_topics` rows exist), which both repairs the chicken-and-egg and scopes the coercive mechanic to onboarded users.

- [ ] **Step 1: Write the failing test**

```js
// backend/test/weekly_topic_assignment.test.js
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const weeklyAssignmentService = require('../src/services/weeklyAssignmentService');

jest.setTimeout(60000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const loginRes = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: row.rows[0].id, username, token: loginRes.body.token };
};

describe('Topic-aware weekly assignment', () => {
  const cleanup = { userIds: [], eventIds: [], topicIds: [] };
  let user, topicId, inTopicEvent, offTopicEvent;

  beforeAll(async () => {
    user = await createUser('weeklyuser');
    cleanup.userIds.push(user.id);

    const t = await db.query(
      `INSERT INTO topics (name, slug, is_user_facing) VALUES ('WeeklyTest', 'weekly-test-' || floor(random()*1e9), TRUE) RETURNING id`
    );
    topicId = t.rows[0].id;
    cleanup.topicIds.push(topicId);

    const pad = await db.query(`SELECT id FROM topics WHERE is_user_facing AND id <> $1 LIMIT 2`, [topicId]);
    await request(app).put('/api/users/me/topics').set('Authorization', `Bearer ${user.token}`)
      .send({ topicIds: [topicId, ...pad.rows.map((r) => r.id)] });
    // Narrow preferences to ONLY the test topic so selection is deterministic:
    await db.query('DELETE FROM user_topics WHERE user_id = $1 AND topic_id <> $2', [user.id, topicId]);

    const mk = async (title) => {
      const ev = await db.query(
        `INSERT INTO events (title, closing_date, market_prob) VALUES ($1, NOW() + INTERVAL '30 days', 0.5) RETURNING id`, [title]
      );
      cleanup.eventIds.push(ev.rows[0].id);
      return ev.rows[0].id;
    };
    inTopicEvent = await mk('weekly in-topic event');
    offTopicEvent = await mk('weekly off-topic event');
    await db.query(`INSERT INTO event_topics (event_id, topic_id, source) VALUES ($1, $2, 'test')`, [inTopicEvent, topicId]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM weekly_user_assignments WHERE user_id = ANY($1::int[])', [cleanup.userIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.topicIds.length) await db.query('DELETE FROM topics WHERE id = ANY($1::int[])', [cleanup.topicIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('assigns onboarded user an event from their topics', async () => {
    const summary = await weeklyAssignmentService.assignWeeklyPredictions();
    expect(summary.assigned).toBeGreaterThanOrEqual(1);

    const row = await db.query(
      'SELECT event_id FROM weekly_user_assignments WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [user.id]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].event_id).toBe(inTopicEvent);
  });

  test('user without topics gets no assignment', async () => {
    const lurker = await createUser('weeklylurker');
    cleanup.userIds.push(lurker.id);
    await weeklyAssignmentService.assignWeeklyPredictions();
    const row = await db.query('SELECT 1 FROM weekly_user_assignments WHERE user_id = $1', [lurker.id]);
    expect(row.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec intellacc_backend npx jest test/weekly_topic_assignment.test.js --runInBand`
Expected: FAIL — user not assigned (eligibility filter) or assigned the wrong event (no topic filter).

- [ ] **Step 3: Modify `assignWeeklyPredictions`**

In `backend/src/services/weeklyAssignmentService.js`:

**(a)** Replace the user-eligibility subquery (line ~77):

```sql
-- BEFORE: AND id IN (SELECT DISTINCT user_id FROM market_updates)  -- Only active traders
-- AFTER:
AND id IN (SELECT DISTINCT user_id FROM user_topics)  -- Onboarded users only
```

**(b)** Replace the events query (~lines 90–101) to carry topic ids:

```js
const eventsResult = await client.query(`
  SELECT e.id, e.title, e.closing_date, e.market_prob,
         COUNT(p.id) AS prediction_count,
         COALESCE(ARRAY_AGG(DISTINCT et.topic_id) FILTER (WHERE et.topic_id IS NOT NULL), '{}') AS topic_ids
  FROM events e
  LEFT JOIN predictions p ON e.id = p.event_id
  LEFT JOIN event_topics et ON et.event_id = e.id
  WHERE e.closing_date > NOW() + INTERVAL '7 days'
  AND e.outcome IS NULL
  AND e.market_prob IS NOT NULL
  GROUP BY e.id, e.title, e.closing_date, e.market_prob
  HAVING COUNT(p.id) < 50
  ORDER BY COUNT(p.id) ASC, e.closing_date DESC
  LIMIT 100
`);
```

**(c)** Load each user's topics once before the per-user assignment loop:

```js
const userTopicsResult = await client.query(
  `SELECT user_id, ARRAY_AGG(topic_id) AS topic_ids FROM user_topics
   WHERE user_id = ANY($1::int[]) GROUP BY user_id`,
  [usersResult.rows.map((u) => u.id)]
);
const topicsByUser = new Map(userTopicsResult.rows.map((r) => [r.user_id, r.topic_ids]));
```

**(d)** Inside the per-user loop, where the existing code picks an event for the user, prefer in-topic events and keep the existing pick logic as fallback (read the loop first — it picks from `eventsResult.rows`; wrap that choice):

```js
const myTopics = new Set(topicsByUser.get(user.id) || []);
const candidateEvents = eventsResult.rows.filter(
  (ev) => /* keep any existing per-user exclusions (already-predicted etc.) */ true
);
const inTopic = candidateEvents.filter((ev) => (ev.topic_ids || []).some((t) => myTopics.has(t)));
const pool = inTopic.length > 0 ? inTopic : candidateEvents; // fallback: any open event
// …existing selection logic (least-predicted first) now runs against `pool`
```

Preserve everything else in the function (stake computation, `weekly_assignment_week` update, stats upsert) — only eligibility, the events query, and the pick pool change.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec intellacc_backend npx jest test/weekly_topic_assignment.test.js --runInBand`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full backend suite (assignment touches shared tables)**

Run: `docker exec intellacc_backend npm test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/weeklyAssignmentService.js backend/test/weekly_topic_assignment.test.js
git commit -m "feat(weekly): topic-aware assignment; eligibility = onboarded users (fixes zero-assignment bug)"
```

---

### Task 8: Frontend — topic picker + login gate

**Files:**
- Create: `frontend-solid/src/components/onboarding/TopicPicker.jsx`
- Modify: `frontend-solid/src/services/api.js` (add topics endpoints)
- Modify: `frontend-solid/src/VanApp.jsx` (gate)

- [ ] **Step 1: Add API methods to `frontend-solid/src/services/api.js`**

Inside the `api` object (next to `users`):

```js
topics: {
  list: () => request('/topics'),
  getMine: () => request('/users/me/topics'),
  setMine: (topicIds) =>
    request('/users/me/topics', { method: 'PUT', body: JSON.stringify({ topicIds }) })
},
discover: {
  feed: () => request('/discover/feed'),
  predictors: () => request('/discover/predictors')
},
```

(Match the existing `request` helper signature in that file — check how other `PUT`/`POST` calls pass bodies and mirror it exactly.)

- [ ] **Step 2: Create `TopicPicker.jsx`**

```jsx
// frontend-solid/src/components/onboarding/TopicPicker.jsx
import { createSignal, createResource, For, Show } from 'solid-js';
import { api } from '../../services/api';

const MIN_TOPICS = 3;

export default function TopicPicker(props) {
  const [topics] = createResource(() => api.topics.list().then((r) => r.topics || []));
  const [selected, setSelected] = createSignal(new Set());
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (selected().size < MIN_TOPICS || saving()) return;
    setSaving(true);
    setError('');
    try {
      await api.topics.setMine([...selected()]);
      props.onDone?.();
    } catch (err) {
      setError(err?.message || 'Failed to save topics');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="topic-picker">
      <h1>Pick your topics</h1>
      <p>
        Choose at least {MIN_TOPICS} topics. You'll get a weekly prediction
        question from them, and your feed starts with the best predictors in
        these areas. You can change them later in Settings.
      </p>
      <Show when={!topics.loading} fallback={<p>Loading topics…</p>}>
        <div class="topic-grid">
          <For each={topics()}>
            {(topic) => (
              <button
                type="button"
                classList={{ 'topic-option': true, selected: selected().has(topic.id) }}
                onClick={() => toggle(topic.id)}
              >
                <strong>{topic.name}</strong>
                <span>{topic.description?.split('.')[0]}.</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <div class="topic-picker-actions">
        <span>{selected().size}/{MIN_TOPICS} minimum</span>
        <button type="button" onClick={submit} disabled={selected().size < MIN_TOPICS || saving()}>
          {saving() ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Add styles to `frontend-solid/src/styles.css`** (near `.empty-feed` block)

```css
/* Topic onboarding picker (blocking gate) */
.topic-picker {
  max-width: 720px;
  margin: 10vh auto 0;
  padding: 2rem;
  background: var(--card-bg);
  box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
}

.topic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
  margin: 1.5rem 0;
}

.topic-option {
  display: grid;
  gap: 0.3rem;
  padding: 0.85rem;
  text-align: left;
  border: 1px solid var(--border-color);
  background: transparent;
  cursor: pointer;
}

.topic-option.selected {
  border-color: var(--primary-color);
  background: rgba(var(--primary-color-rgb), 0.08);
}

.topic-picker-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
```

- [ ] **Step 4: Gate in `VanApp.jsx`**

```jsx
// Additional imports at the top of VanApp.jsx:
import TopicPicker from './components/onboarding/TopicPicker';
import { api } from './services/api';
import { isAuthenticated } from './services/auth';

// Inside export default function App(), alongside existing signals:
const [needsTopics, setNeedsTopics] = createSignal(false);

const checkTopics = async () => {
  if (!isAuthenticated()) {
    setNeedsTopics(false);
    return;
  }
  try {
    const res = await api.topics.getMine();
    setNeedsTopics((res?.topicIds || []).length === 0);
  } catch {
    setNeedsTopics(false); // fail open: a topics outage must not lock the app
  }
};

onMount(() => {
  checkTopics();
  window.addEventListener('solid-auth-changed', checkTopics);
});
onCleanup(() => window.removeEventListener('solid-auth-changed', checkTopics));
```

And in the JSX return, gate non-auth pages (auth pages must stay reachable so login/signup work):

```jsx
<Show
  when={isAuthPage()}
  fallback={
    <Layout page={page()}>
      <Show when={!needsTopics()} fallback={<TopicPicker onDone={() => setNeedsTopics(false)} />}>
        {renderPage()}
      </Show>
    </Layout>
  }
>
  {renderPage()}
</Show>
```

- [ ] **Step 5: Verify in the dev stack**

Run: `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` (ALWAYS with `-p solid-local`), then log in as a user with no `user_topics` rows on `http://localhost:4174/#home`.
Expected: blocking picker; Continue disabled until 3 selected; after Continue the normal page renders; reload does not re-show the picker.

- [ ] **Step 6: Commit**

```bash
git add frontend-solid/src/components/onboarding/TopicPicker.jsx frontend-solid/src/VanApp.jsx frontend-solid/src/services/api.js frontend-solid/src/styles.css
git commit -m "feat(onboarding): blocking topic picker after login"
```

---

### Task 9: Frontend — discover feed fallback + follow buttons

**Files:**
- Modify: `frontend-solid/src/pages/HomePage.jsx`
- Modify: `frontend-solid/src/components/posts/PostsList.jsx`
- Modify: `frontend-solid/src/components/posts/PostItem.jsx`

- [ ] **Step 1: HomePage — fall back to discover feed when the following-feed is empty**

In `HomePage.jsx`, add a signal and extend `loadPosts` (after the page-1 result is known):

```jsx
import { api, followUser } from '../services/api'; // alongside existing imports
const [discoverMode, setDiscoverMode] = createSignal(false);
```

At the end of the successful `reset` branch in `loadPosts` (after `setPosts(nextPosts)` / `setHasMore` / `setNextCursor`):

```jsx
if (reset && usingFeed() && nextPosts.length === 0) {
  try {
    const discover = await api.discover.feed();
    if ((discover?.items || []).length > 0) {
      setDiscoverMode(true);
      setPosts(discover.items);
      setHasMore(false);
      setNextCursor(null);
      return;
    }
  } catch (err) {
    console.error('Discover feed failed:', err); // keep the empty feed; never block home on discover
  }
}
if (reset) setDiscoverMode(false);
```

Handle the follow action — following someone flips back to the real feed:

```jsx
const handleFollowed = async () => {
  setDiscoverMode(false);
  await loadPosts({ reset: true });
};
```

In the JSX, label discover mode above `<PostsList …>` and pass the new props:

```jsx
<Show when={discoverMode()}>
  <p class="discover-notice">
    Showing top predictors in your topics — follow people to make this feed yours.
  </p>
</Show>
<PostsList
  posts={posts}
  onPostUpdate={updatePost}
  onPostDelete={removePost}
  loading={loading}
  loadingMore={loadingMore}
  hasMore={hasMore}
  discoverMode={discoverMode}
  onFollowed={handleFollowed}
/>
```

- [ ] **Step 2: PostsList — pass-through props**

In `PostsList.jsx`, forward the two new props to each item:

```jsx
<PostItem
  post={post}
  onPostUpdate={props.onPostUpdate}
  onPostDelete={props.onPostDelete}
  discoverMode={props.discoverMode?.()}
  onFollowed={props.onFollowed}
/>
```

- [ ] **Step 3: PostItem — follow button in discover mode**

Read `PostItem.jsx` first and place the button next to the username header. Logic:

```jsx
import { followUser } from '../../services/api'; // adjust to that file's import style
const [followBusy, setFollowBusy] = createSignal(false);

const handleFollow = async () => {
  if (followBusy()) return;
  setFollowBusy(true);
  try {
    await followUser(props.post.user_id);
    props.onFollowed?.();
  } catch (err) {
    console.error('Follow failed:', err);
    setFollowBusy(false);
  }
};
```

```jsx
<Show when={props.discoverMode}>
  <button type="button" class="follow-btn" onClick={handleFollow} disabled={followBusy()}>
    {followBusy() ? '…' : 'Follow'}
  </button>
</Show>
```

CSS (in `styles.css`, near `.discover-notice`):

```css
.discover-notice {
  margin: 0.75rem 0;
  padding: 0.6rem 0.85rem;
  border: 1px dashed var(--border-color);
  color: var(--secondary-text);
  text-align: center;
}

.follow-btn {
  margin-left: 0.5rem;
  padding: 0.1rem 0.6rem;
  font-size: 0.78rem;
  border: 1px solid var(--primary-color);
  color: var(--primary-color);
  background: transparent;
  cursor: pointer;
}
```

- [ ] **Step 4: Verify in the dev stack**

With a fresh user (topics picked, follows nobody): home shows the discover notice + posts by predictors with Follow buttons; clicking Follow reloads into the real following-feed showing that author's posts.
With a user who follows people: feed unchanged, no notice, no Follow buttons.

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/pages/HomePage.jsx frontend-solid/src/components/posts/PostsList.jsx frontend-solid/src/components/posts/PostItem.jsx frontend-solid/src/styles.css
git commit -m "feat(discover): empty feed falls back to top predictors with follow buttons"
```

---

### Task 10: Frontend — weekly question card on home

**Files:**
- Create: `frontend-solid/src/components/predictions/WeeklyQuestionCard.jsx`
- Modify: `frontend-solid/src/pages/HomePage.jsx`
- Modify: `frontend-solid/src/services/api.js`

- [ ] **Step 1: API method**

The backend route is `GET /api/weekly/user/:userId/status` (already exists, JWT-authed). Add next to the other api groups (check whether `api.weekly` already exists in `api.js` — `EventsList.jsx` uses weekly endpoints; if a method is already there, reuse it instead of adding a duplicate):

```js
weekly: {
  userStatus: (userId) => request(`/weekly/user/${userId}/status`)
},
```

- [ ] **Step 2: Component**

```jsx
// frontend-solid/src/components/predictions/WeeklyQuestionCard.jsx
import { createResource, Show } from 'solid-js';
import { api } from '../../services/api';
import { getUserId } from '../../services/auth'; // check services/auth.js for the actual current-user-id accessor; adapt if named differently

export default function WeeklyQuestionCard() {
  const [status] = createResource(() => {
    const userId = getUserId();
    if (!userId) return null;
    return api.weekly.userStatus(userId).catch(() => null);
  });

  // Render only when there is an open, uncompleted assignment this week.
  const assignment = () => {
    const s = status();
    if (!s || s.completed || !s.event_id) return null;
    return s;
  };

  return (
    <Show when={assignment()}>
      {(a) => (
        <div class="weekly-question-card">
          <span class="label">Your weekly question</span>
          <p>{a().event_title || `Event #${a().event_id}`}</p>
          <button type="button" onClick={() => (window.location.hash = `predictions/${a().event_id}`)}>
            Stake now
          </button>
        </div>
      )}
    </Show>
  );
}
```

**Adapt to the real response shape:** run `docker exec intellacc_backend node -e` against a seeded user or read `weeklyAssignmentController.getUserWeeklyStatus` to confirm field names (`completed`, `event_id`, `event_title`), and adjust the component before committing.

- [ ] **Step 3: Mount it in `HomePage.jsx`** directly above the feed (inside the `isAuthenticated()` section, before `CreatePostForm`):

```jsx
<WeeklyQuestionCard />
```

CSS:

```css
.weekly-question-card {
  margin-bottom: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--primary-color);
  background: rgba(var(--primary-color-rgb), 0.06);
}
```

- [ ] **Step 4: Verify in the dev stack** — assign manually first:

Run: `docker exec intellacc_backend node -e "require('./src/services/weeklyAssignmentService').assignWeeklyPredictions().then(r => { console.log(r); process.exit(0); })"`
Expected: card appears on home for an onboarded user, links to the predictions page; completing the prediction hides the card on reload.

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/components/predictions/WeeklyQuestionCard.jsx frontend-solid/src/pages/HomePage.jsx frontend-solid/src/services/api.js frontend-solid/src/styles.css
git commit -m "feat(weekly): weekly question card on home"
```

---

### Task 11: E2E spec — onboarding journey

**Files:**
- Create: `tests/e2e/topic-onboarding.spec.js`

- [ ] **Step 1: Write the spec** (mirror setup/teardown patterns from `tests/e2e/solid-messaging.spec.js` — base URL, signup helpers, and the self-cleaning test-user convention with `KEEP_E2E_USERS=1` support):

```js
// tests/e2e/topic-onboarding.spec.js
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4174';
const unique = Date.now();
const USER = {
  username: `onboard_${unique}`,
  email: `onboard_${unique}@example.com`,
  password: 'password123'
};

test('new user is gated by topic picker, then lands on discover feed', async ({ page }) => {
  await page.goto(`${BASE_URL}/#signup`);
  await page.fill('input[name="username"], #username', USER.username);
  await page.fill('input[type="email"]', USER.email);
  await page.fill('input[type="password"]', USER.password);
  await page.click('button[type="submit"]');

  // Blocked: topic picker shows instead of home
  await expect(page.locator('.topic-picker')).toBeVisible({ timeout: 15000 });
  const continueBtn = page.locator('.topic-picker-actions button');
  await expect(continueBtn).toBeDisabled();

  // Pick 3 topics → continue enabled → home renders
  const options = page.locator('.topic-option');
  for (let i = 0; i < 3; i++) await options.nth(i).click();
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();
  await expect(page.locator('.topic-picker')).toHaveCount(0, { timeout: 10000 });

  // Reload: gate must not reappear
  await page.reload();
  await expect(page.locator('.topic-picker')).toHaveCount(0, { timeout: 10000 });
});
```

(Adapt the signup selectors after reading `SignUpPage.jsx` — use the actual input names/ids. If prod data guarantees no discover-feed content for a brand-new user's topics, asserting `.discover-notice` is flaky; the gate-and-release flow is the stable assertion, so leave discover assertions out unless the dev DB is seeded.)

- [ ] **Step 2: Run it** (needs the solid-local stack up)

Run: `npx playwright test tests/e2e/topic-onboarding.spec.js`
Expected: PASS.

- [ ] **Step 3: Clean up the test user**

Add the cleanup `afterAll` mirroring the existing specs' self-cleaning convention (delete the created user via the API or psql unless `KEEP_E2E_USERS=1`).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/topic-onboarding.spec.js
git commit -m "test(e2e): topic onboarding gate journey"
```

---

### Task 12: Prod rollout + weekly cron verification

**Files:** none new (operations + possibly `docker-compose-cron.yml` env)

- [ ] **Step 1: Deploy** — `git push`, then `docker restart intellacc_backend intellacc_frontend_solid` (migration auto-runs; frontend rebuild ~2 min).

- [ ] **Step 2: Run the backfill in prod** (Task 3 script) and re-verify topic distribution.

- [ ] **Step 3: Verify weekly cron auth end-to-end**

Run: `docker exec intellacc_weekly_cron node /usr/src/app/weekly_cron.js`
Expected: weekly run completes; check `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT count(*) FROM weekly_user_assignments;"` — rows appear for every user with `user_topics`. If the run fails on auth, fix `WEEKLY_ADMIN_TOKEN` / `WEEKLY_ADMIN_EMAIL` / `WEEKLY_ADMIN_PASSWORD` in the cron container env (`docker-compose-cron.yml` + `backend/.env`), then `docker compose -f docker-compose-cron.yml up -d`.

- [ ] **Step 4: Smoke the live flow** — fresh signup on intellacc.de: picker gates, topics save, home renders; existing users get gated on next visit (expected, by design).

- [ ] **Step 5: Final commit/push** of any rollout fixes.

---

## Self-review notes

- **Spec coverage:** §1 data model → Task 1; §2 classification → Task 2–3; §2 validation gate → Task 4 (explicit STOP); §3 gate+API → Tasks 5, 8; §4 discover → Tasks 6, 9; §5 weekly → Tasks 7, 10, 12; §6 testing → tests in each task + Task 11; §7 rollout → Task 12 (order preserved: migration → backfill → gate → endpoints → UI → E2E → cron).
- **Known judgment calls baked in:** eligibility = `user_topics` (fixes the zero-assignment bug found during planning); discover feed uses a slim SELECT but must include the post-visibility clause (called out in Task 6).
- **Adaptation points flagged inline** (exact variable names at `predictionsController.js:367`, weekly status response shape, signup selectors) — each names the file to read first.
