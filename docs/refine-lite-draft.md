# Refine-Lite Deep Review (Draft)

Status: draft only, no implementation in this document.

## Terminology Alignment (with Persuasive Alpha v1)
- `event` is the canonical DB term (UI label can still say `market`).
- `post_market_matches` remains the scoring-critical match source for reward attribution.
- `post_market_links` / `verification_actions` remain advisory + human-label surfaces.
- `post_analysis.processing_status` lifecycle naming is reused: `pending -> gated_out|retrieving|reasoning|complete|failed`.
- Deep review is additive and must not mutate payout tables (`post_signal_episodes`, `post_signal_reward_payouts`) or balances.

## Objective
- Add an optional deep-review pipeline for long-form posts.
- Return structured critique and argument mapping, not rewritten content.
- Reuse existing post analysis foundations (gate, retrieval, reasoner, verification) and existing event/market matching terminology.

## Non-Goals (v1)
- No automatic post blocking.
- No automatic content rewriting.
- No citation/bibliography formatting checker.
- No hard dependency on a single model vendor.

## Product Behavior
1. User publishes a post normally.
2. If post is eligible for deep review, backend queues async analysis.
3. UI shows `processing_status` and later renders a review report.
4. Author and readers can mark items as helpful/incorrect.
5. Feedback becomes training/evaluation data for later tuning.

## Eligibility Gate
- Auto-run when `word_count >= 400` (configurable).
- Manual run button for shorter posts (rate limited).
- Skip when daily budget is exhausted.

Config (draft):
- `POST_SIGNAL_DEEP_REVIEW_ENABLED=true|false`
- `POST_SIGNAL_DEEP_REVIEW_MIN_WORDS=400`
- `POST_SIGNAL_DEEP_REVIEW_DAILY_BUDGET=500`
- `POST_SIGNAL_DEEP_REVIEW_PER_USER_DAILY_LIMIT=3`

## Pipeline
1. `Normalize`
- Clean text, split sections, compute word count, detect links/entities.

2. `Gate`
- Cheap model classifies whether post contains analyzable forward-looking claims.
- Outputs: `has_claim`, `domain`, `claim_summary`, `entities`.

3. `Retrieve`
- Hybrid retrieval against open events/markets:
- Embedding search on `claim_summary`.
- FTS/BM25 on `claim_summary + entities`.
- Keep top N candidates (default 15).

4. `Reason`
- Heavier model returns:
- Propositions and logical relations.
- Best event/market match + stance.
- Critique items with severity.
- Conditional links if present.

5. `Persist + Render`
- Save one review run + many review items.
- Expose report via API and UI.

## Data Model (Draft)

### 1) `post_deep_reviews`
One row per run.

```sql
CREATE TABLE IF NOT EXISTS post_deep_reviews (
  id BIGSERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending','gated_out','retrieving','reasoning','complete','failed')),
  skip_reason VARCHAR(30) CHECK (skip_reason IN ('budget_exhausted','per_user_limit','below_word_threshold')),
  has_claim BOOLEAN DEFAULT FALSE,
  domain VARCHAR(50),
  claim_summary TEXT,
  entities TEXT[] DEFAULT '{}',
  gate_model VARCHAR(120),
  reason_model VARCHAR(120),
  gate_latency_ms INTEGER,
  reason_latency_ms INTEGER,
  error_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_deep_reviews_post_id ON post_deep_reviews(post_id);
CREATE INDEX IF NOT EXISTS idx_post_deep_reviews_status ON post_deep_reviews(status);
```

### 2) `post_deep_review_items`
Structured findings.

```sql
CREATE TABLE IF NOT EXISTS post_deep_review_items (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES post_deep_reviews(id) ON DELETE CASCADE,
  item_type VARCHAR(30) NOT NULL CHECK (item_type IN ('logic','event_match','clarity','quant','conditional','other')),
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('info','warning','error')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_quote TEXT,
  related_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  confidence REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_deep_review_items_review_id ON post_deep_review_items(review_id);
CREATE INDEX IF NOT EXISTS idx_post_deep_review_items_severity ON post_deep_review_items(severity);
```

### 3) `post_deep_review_feedback`
Human labels for quality control.

```sql
CREATE TABLE IF NOT EXISTS post_deep_review_feedback (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL REFERENCES post_deep_review_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote VARCHAR(20) NOT NULL CHECK (vote IN ('helpful','incorrect','unclear')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(item_id, user_id)
);
```

## API Contract (Draft)

### Start/restart review
- `POST /api/posts/:id/deep-review`
- Auth required, author-only for manual trigger.
- Returns `{ review_id, status }`.

### Poll latest review
- `GET /api/posts/:id/deep-review`
- Returns run metadata + top issues.
- Optional: include `processing_status` view compatible with `GET /api/posts/:id/analysis-status`.

### Submit feedback
- `POST /api/deep-review/items/:itemId/feedback`
- Body: `{ vote: "helpful" | "incorrect" | "unclear" }`.

## Model Output Schemas (Draft)

### Gate Output JSON Schema
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "has_claim": { "type": "boolean" },
    "domain": { "type": ["string", "null"] },
    "claim_summary": { "type": ["string", "null"] },
    "entities": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["has_claim", "domain", "claim_summary", "entities"]
}
```

### Reasoner Output JSON Schema
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "best_market": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "properties": {
        "event_id": { "type": "integer" },
        "stance": { "type": "string", "enum": ["agrees", "disagrees", "related"] },
        "confidence": { "type": "number" }
      },
      "required": ["event_id", "stance", "confidence"]
    },
    "propositions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "label": { "type": "string" },
          "prop_type": { "type": "string", "enum": ["premise", "conclusion", "assumption", "evidence", "conditional_antecedent"] },
          "content": { "type": "string" }
        },
        "required": ["label", "prop_type", "content"]
      }
    },
    "relations": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "from": { "type": "string" },
          "to": { "type": "string" },
          "relation_type": { "type": "string", "enum": ["supports", "implies", "contradicts", "conditional", "conjunction", "disjunction", "unless"] }
        },
        "required": ["from", "to", "relation_type"]
      }
    },
    "critiques": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "item_type": { "type": "string" },
          "severity": { "type": "string", "enum": ["info", "warning", "error"] },
          "title": { "type": "string" },
          "description": { "type": "string" },
          "confidence": { "type": "number" }
        },
        "required": ["item_type", "severity", "title", "description", "confidence"]
      }
    }
  },
  "required": ["best_market", "propositions", "relations", "critiques"]
}
```

## Queue and Worker (Draft)
- Queue table: reuse existing queue pattern (`FOR UPDATE SKIP LOCKED`).
- Worker claims one job, advances status through `retrieving`/`reasoning`, writes all outputs in one DB transaction.
- On failure: set `failed` with `error_text`.
- On budget/limit/threshold short-circuit: set `gated_out` + `skip_reason`.
- Enforce daily and per-user budgets before enqueue.

## Existing Table Interop (No Reward Flow Changes)
- Keep `post_market_matches` as the reward-side source used by attribution/scoring.
- Deep-review output can optionally upsert into `post_market_links` with a distinct `source` value, but must not alter referral attribution rules.
- Reuse existing `propositions`, `prop_relations`, `post_critiques`, and `verification_actions` tables where possible to avoid duplicate semantic stores.

## Safety + Cost Controls
- Hard daily cap and per-user cap.
- Timeout per model call.
- Fallback model chain (configurable).
- Never block post publish; analysis stays async.

## Metrics (Must Collect)
- `gate_pass_rate`
- `retrieval_hit_rate` (candidate set non-empty)
- `reasoner_success_rate`
- `author_override_rate`
- `feedback_helpful_ratio`
- `cost_per_completed_review`
- `p95_review_latency_ms`

## Acceptance Criteria (v1 Draft)
1. Deep review runs asynchronously and never blocks `createPost`.
2. For eligible posts, a review row is created and transitions to terminal state (`complete|failed|gated_out`).
3. Reasoner outputs are schema-validated before persistence.
4. Findings render in UI with severity and text evidence (quote optional; no hard span requirement).
5. Author/reader feedback endpoints work and persist unique votes.
6. Budget limits prevent extra enqueues once caps are hit.
7. Metrics are emitted for every review run.
8. Feature is fully disable-able via env flag with no impact on normal posting.

## Rollout Plan
1. Internal-only behind admin flag.
2. Author opt-in beta for long posts.
3. Measure precision via feedback for 1-2 weeks.
4. Tune prompts/models and only then expand exposure.
