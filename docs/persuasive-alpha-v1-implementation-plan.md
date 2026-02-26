# Persuasive Alpha v1: Truth-Weighted Marginal Information Scoring for Posts

## Summary
Implement a production-safe, attribution-backed reward system for high-signal posts using the agreed model:

- Scope: all posts with auto market matching
- Signal metric: marginal information value from attributed trade episodes
- Horizon mix: 10% / 50% / final = 0.2 / 0.3 / 0.5
- Wrong-direction handling: zero floor (no negative score in v1)
- Payout model: per-score minting (with hard caps)
- Settlement: nightly batch + final on event resolution
- Reliability: uniform initial user weights in v1 (`r_u = 1.0`)

This plan is tailored to current code reality:
- Attribution chain primitives are now in place (`post_market_clicks`, `post_market_matches`, and referral forwarding into market updates).
- The payout and scoring pipeline is still missing:
  - `post_signal_episodes`
  - `post_signal_reward_payouts`
  - nightly scorer/credit runner
- `market_updates` records both buy and sell actions; persuasive-alpha scoring should count both in v1.
- Existing reward runner pattern exists (`market-questions/rewards/run`) and should be reused.
 - Optional matching stack: an additive agentic retrieve-and-reason path is added below for match quality and post semantics; it is feature-flagged and does not alter reward flow.

### 1.0 Clarifications for v1 rollout (addressing open implementation risks)
- Open Problem 1: Market history source for early/mid targets
  - Decision: use the latest `market_updates` row at or before each target timestamp; if no row exists, fallback to `events.market_prob`.
  - Rule must be centralized in a single helper/service.
  - Use `remaining = closing_time - t`, `target_early_time = t + 0.10 * remaining`, `target_mid_time = t + 0.50 * remaining`, and skip any target at/after close.
- Open Problem 2: Reward economics + treasury model
  - Decision: policy is explicit and conservative:
    - Mint only through scheduled reward runs, not on user action.
    - Global/day caps remain configurable and default to safe production limits.
    - `POST_SIGNAL_REWARDS_ENABLED` is the mandatory kill switch for rollout.
    - Treasury mint authority remains server-side and logs every minted batch for audit.
- Open Problem 3: Concurrency and locking in nightly scorer
  - Decision: implement lock-claimed batch claiming (`FOR UPDATE SKIP LOCKED` style) so parallel runners cannot double-credit.
  - Reward run endpoint and job loops should be idempotent by unique constraints and payout table dedupe keys.
- Open Problem 4: Units and normalization ambiguity
  - Decision: define all stake and reward config values as ledger units in docs and code comments.
  - `POST_SIGNAL_MIN_STAKE_LEDGER` is fixed to `1_000_000` (1 RP) in v1 with explicit fixed-point comment.
  - Add a schema-level invariant:
    - 1 RP = 1,000,000 ledger units
    - `rp_balance_ledger`, `stake_amount_ledger`, and reward amounts all stored as integer ledger units
  - Clarify in config section:
    - `POST_SIGNAL_MINT_RATE_LEDGER_PER_POINT` is ledger units per score point.
    - `POST_SIGNAL_*_CAP_LEDGER` values are ledger units.
  - Add tests asserting conversion and threshold behavior:
    - 1 RP minimum stake is accepted at `1_000_000` ledger.
    - lower stake is ignored by threshold filter.
 - Open Problem 5: Sell-side behavior
  - Decision: count every position change in v1, regardless of side.
  - Keep attribution and scoring based on market movement only:
    - score is computed from `p_before` and `p_after` as before.
    - zero-floor rule still prevents negative scoring from wrong-direction movement.
  - Scope note:
    - no separate v1.1 requirement exists solely for sell-side inclusion.
    - telemetry and anomaly monitoring remain required for position-change distribution behavior.
- Open Problem 6: Operations and alerts
  - Decision: add explicit backend observability before launch (no frontend required):
    - Emit structured run logs for every scorer invocation:
      - `run_id`
      - `ts_started`, `ts_finished`, `duration_ms`
      - `trigger` (admin/manual/crontab)
      - `enabled` (POST_SIGNAL_REWARDS_ENABLED)
      - `processed_updates`
      - `attributed_updates`
      - `episodes_created`
      - `payout_rows_created`
      - `minted_ledger_total`
      - `skipped_by_cap`
      - `skipped_by_threshold`
      - `claim_conflicts`
      - `errors`
    - Emit event-level anomalies:
      - missing or stale market snapshots
      - post click without attribution context
      - duplicate payout idempotency conflicts
      - negative score inputs after clamp
    - Add queue/lag visibility:
      - high-water timestamp of unprocessed `market_updates` / `post_signal_episodes`
      - lag_ms since last processed event
    - Track rollback-relevant signals:
      - fatal insertion/update failures
      - reconciliation mismatch between intended payout sum and minted ledger delta
  - Add one lightweight admin visibility surface (same auth as other admin tools):
    - `GET /api/admin/persuasion-score/run-status` returns last N run summaries and current queue lag.
  - Define launch alerts:
    - run errors > 0
    - cap-skip rate > 5% of payout candidates in a single run
    - queue lag > 15 minutes
    - no successful run in 24h
  - Track these in the same logging path used by scheduled jobs (structured JSON logs + JSON summary table in DB if needed).
- Open Problem 7: Schema integration overlap
  - Decision: score/mapping layer is an extension of existing tables (`post_market_clicks`, `post_market_matches`) plus new episode/payout tables.
  - Migration plan must include compatibility checklist:
    - no dropping existing referral columns
    - null-safe reads for legacy rows
    - explicit backfill steps for new nullable foreign keys
- Open Problem 8: Matching stack quality vs cost
  - Decision: keep `post_market_matches` as the scoring-critical source of truth.
  - Matching quality is upgraded via an optional Agentic Match pipeline, but attribution→reward scoring never depends on LLM output.
  - Matching is additive and remains deterministic for rewards:
    - no separate baseline/fallback match-method is required for reward correctness;
    - hybrid retrieval is the only candidate source for `post_market_matches`.
    - if matching fails or yields no results, the post simply stores an empty candidate set and does not block post creation.

### 1A. Optional Agentic Retrieve-and-Reason Matching (Non-Breaking Add-on)

The optional matching path keeps a fast, reproducible candidate pre-filter and uses an optional LLM reasoner for final selection, without touching reward correctness.

#### 1A.1 Architecture

```
POST CREATED
     │
     ▼
┌─────────────────────┐
│ STEP 1: GATE       │  cheap model/classifier
│ "Is this a claim?"  │  domain inference
└────────┬────────────┘
         │ post_gate=true, domain
         ▼
┌─────────────────────┐
│ STEP 2: RETRIEVE   │  pgvector + BM25/TSVector
│ Candidate markets   │  top 10-20
└────────┬────────────┘
         │ [market_1 ... market_n]
         ▼
┌─────────────────────┐
│ STEP 3: REASON     │  reasoning model
│ Select best match    │  stance + confidence
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ STEP 4: ATTACH     │  store match proposal + critique candidates
│ Link proposal       │  async after post create
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ STEP 5: VERIFY     │  author/reader labels
│ Confirm / reject    │  feedback loop
└─────────────────────┘
```

#### 1A.2 Hard safety constraints
- No post/UX path depends on final matching success.
- Reward pipeline still uses deterministic attribution sources only (`post_market_clicks` and referral context from `market_updates`).
- Keep `post_market_matches.match_method` as the canonical pipeline marker:
  - default to `hybrid_v1` for normal hybrid retrieval runs.
  - do not persist a separate `'fts_v1'` fallback row when gate/reasoner fails.
- Feature flags:
  - `POST_SIGNAL_AGENTIC_MATCH_ENABLED`
  - `POST_SIGNAL_MATCH_GATE_ENABLED`
  - `POST_SIGNAL_MATCH_REASONER_ENABLED`
- Retrieval uses one hybrid SQL path (vector + TS ranking) and then passes candidates to the reasoner.
- Non-matching/failing branches do not switch to an alternate candidate method; they keep the latest `post_market_matches` state from hybrid retrieval (including possibly zero rows).
- **Required implementation hardening before Sprint 1:**
  1. **Transaction boundary for pipeline writes**
    - `storeArgumentGraph`, `storeMarketLink`, `storeConditionalFlags`, and `storeCritiques` must execute in a single DB transaction.
    - Acquire a dedicated client:
      - `BEGIN`
      - perform all writes
      - `COMMIT`
      - `ROLLBACK` on any failure.
    - This prevents partially persisted graph states when a mid-pipeline write fails.
  2. **No hard dependency on exact span offsets**
     - Do not require `evidence_start`/`evidence_end` for matching quality or persistence.
     - Drop fragile span-based validation from v1 matching MVP.
     - Store only proposition content + structural relations generated by the model.
     - Keep relation insertion resilient by only attaching edges where both proposition nodes exist.
     - Correctness is enforced by human feedback paths (`confirm_market_match`, `reject_market_match`, etc.), not brittle token offsets.
  3. **FTS matching should be recall-first**
     - Replace strict `plainto_tsquery` usage with `websearch_to_tsquery` or explicit OR-style terms for entity fields to reduce false negatives.
     - Keep it as a ranking signal; no single source should block vector-based candidates.
  4. **OpenRouter client resilience**
     - Keep `OPENROUTER_API_KEY` with a wrapper that enforces timeout and model fallback (`primary`/`backup` model strings) at the call layer.
     - Model choice remains config-driven and non-breaking (`match config only`).

#### 1A.3 Additive implementation phases

Phase 1 (foundations):
- pgvector + `events.embedding` + HNSW index (opt-in)
- `events.search_vector` generated tsvector (opt-in)
- optional `events.domain`

Phase 2 (pipeline services, async):
- `services/claimGate` → classify claim + domain from post text
- `services/marketRetrieval` → candidate ranking via vector + text
- `services/argumentExtractor` → best-market selection + stance/confidence + optional critique tags
- `services/postPipeline` orchestrator:
  - write `post_analysis`
  - persist `post_market_links` / `propositions` / `prop_relations` / `post_critiques`
  - never block response path

Phase 3 (APIs + UX):
- analysis status endpoint for polling
- match proposal endpoint
- market-link confirm/override endpoint
- reader verification endpoint (verification actions stream)
- display proposal + confidence + critique in post view (optional)

Phase 4 (governance):
- use `verification_actions` only as training labels and ranking telemetry
- no impact to v1 scoring, payout, or cooldown logic

#### 1A.4 Config defaults
- `OPENROUTER_API_KEY` (single LLM key for gate/reasoner)
- `POST_SIGNAL_AGENTIC_MATCH_ENABLED=false`
- `POST_SIGNAL_MATCH_GATE_ENABLED=false`
- `POST_SIGNAL_MATCH_REASONER_ENABLED=false`
- `POST_SIGNAL_MATCH_CANDIDATE_LIMIT=15`
- `POST_SIGNAL_MATCH_TIMEOUT_MS=4000`
- `POST_SIGNAL_MATCH_MODEL=<low-cost gate model>`
- `POST_SIGNAL_REASON_MODEL=<reasoning model>`
- `POST_SIGNAL_MATCH_DAILY_BUDGET=0` (0 = no hard budget cap)

#### 1A.5 Sprint 1 execution checklist (concrete, non-blocking to v1 rewards)

Goal: ship a minimal, resilient matching add-on without touching payout correctness.

1) Foundation schema & index work (1–2 files)
- [x] Add `pgvector` extension migration:
  - `CREATE EXTENSION IF NOT EXISTS vector;`
  - `ALTER TABLE events ADD COLUMN IF NOT EXISTS embedding vector(768);`
  - `CREATE INDEX IF NOT EXISTS idx_events_embedding ON events USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200);`
- [x] Add TSVector search column:
  - `ALTER TABLE events ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (...) STORED;`
  - `CREATE INDEX IF NOT EXISTS idx_events_fts ON events USING GIN(search_vector);`
- [x] Add optional domain filter:
  - `ALTER TABLE events ADD COLUMN IF NOT EXISTS domain VARCHAR(50);`
  - `CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain);`
  - `CREATE INDEX IF NOT EXISTS idx_events_domain_open ON events(domain) WHERE outcome IS NULL AND closing_date > NOW();`

2) Match service layer (new files)
- [x] Add `backend/src/services/llmClient.js` or equivalent wrapper:
  - single `callLLM({ model, messages, max_tokens, extraParams })`
  - timeout + abort + JSON parse guard
  - retry/fallback model chain from config
- [x] Add `backend/src/services/openRouterMatcher/claimGate.js`:
  - classify `has_claim`, `domain`, `claim_summary`, `entities`
- [x] Add `backend/src/services/openRouterMatcher/marketRetrieval.js`:
  - embedding call + hybrid SQL (vector + tsvector)
  - returns ranked candidates only, never throws hard failures
- [x] Add `backend/src/services/openRouterMatcher/argumentExtractor.js` (opt-in Stage 3):
  - strict JSON schema prompt without span requirements
  - returns best market + propositions/relations (no evidence offsets)
- [x] Add `backend/src/services/openRouterMatcher/postPipeline.js` orchestrator:
  - writes `post_analysis` row
  - optional async proposal path (no reward writes)
  - uses one client transaction for DB writes

3) Storage hardening (existing + new schema)
- [x] Add optional tables for pipeline:
  - `post_analysis`
  - `propositions` (text + structural attributes only; no evidence offsets)
  - `prop_relations`
  - `post_market_links`
  - `conditional_flags`
  - `post_critiques`
  - `verification_actions`
- [x] Add `post_analysis` status transitions:
  - `pending -> gated_out/retrieving/reasoning/complete/failed`.

4) API + route wiring
- [x] Extend `backend/src/api.js`:
  - `GET /api/posts/:id/analysis-status`
- [x] Extend `backend/src/api.js`:
  - `GET /api/posts/:id/market-link`
  - `POST /api/posts/:id/confirm-market`
  - `POST /api/posts/:id/verify`
  - keep auth checks consistent with existing user/session middleware
- [x] Add matching controller methods in `backend/src/controllers/persuasiveAlphaController.js` for these remaining routes.
- [x] Keep existing reward and market update flows unchanged:
  - no schema fields required by `POST /api/events/:eventId/update`.
- [x] Keep all user-facing post rendering backward-compatible if these endpoints are not enabled.

5) Post create trigger (non-blocking async)
- [x] In `backend/src/controllers/postController.js`:
  - after `INSERT posts`, enqueue `postPipeline.processPost(post.id, post.content)` in a `catch`-logged background task.
  - immediate response remains existing response contract.
- [x] Gate LLM path behind flags:
  - `POST_SIGNAL_AGENTIC_MATCH_ENABLED`
  - `POST_SIGNAL_MATCH_GATE_ENABLED`
  - `POST_SIGNAL_MATCH_REASONER_ENABLED`

6) Observability + idempotency
- [x] Log pipeline outcome with `post_id`, status, candidate count, duration, and error class.
- [x] Add dedupe index/unique constraints for proposal writes:
  - `post_market_links (post_id, event_id)` unique (already required by schema target)
  - payout/episode schema unchanged by this feature path.

7) Tests for Sprint 1
- [x] Unit tests in `backend/test/`:
  - gate output parser + JSON normalization validation
  - `websearch_to_tsquery` query builder fallback behavior
  - transaction rollback on simulated mid-pipeline failure
  - malformed JSON from model does not throw; logs error and keeps hybrid retrieval semantics (empty candidates acceptable when retrieval is unavailable).
- [x] Integration tests:
  - create post -> proposals exist for matching path
- [x] Guardrails tests:
  - when `POST_SIGNAL_MATCH_REASONER_ENABLED=false`, pipeline persists hybrid retrieval-only candidate rows from retrieval stage.
  - malformed LLM JSON does not affect post create path or reward tables.

8) Launch criteria for this sprint
- [x] `POST /posts` response behavior unchanged.
- [x] New match pipeline never mutates `rp_balance_ledger` or `post_signal_*` payout tables.
- [x] `post_market_clicks` + referral scoring path unaffected and still deterministic.
- [x] At least one non-empty matching candidate set observed in staging for known market-related posts.
  - Run: `E2E_BASE_URL=https://<staging-host> SMOKE_TOKEN=<bearer> scripts/smoke-post-match.sh`
  - 2026-02-25 smoke observation on `https://intellacc.com`:
    - created `post_id=652`
    - final analysis status: `complete`
    - matched markets: `15`
  - 2026-02-25 smoke observation on `https://intellacc.de`:
    - created `post_id=653`
    - final analysis status: `complete`
    - matched markets: `15`
  - note: event creation returned `403` for smoke user (verification gate), so script used existing open event fallback (`event_id=154`), which is acceptable for matcher smoke validation.

## 1. Product and Behavior Spec

### 1.1 Attribution chain (required for any reward)
Instrument this canonical chain:

`post viewed/clicked market chip -> attribution click record -> trade update -> attributed episode`

Rules:
- Attribution is set server-side only (never trust client-provided `referral_post_id`).
- Self-attribution excluded (`post_author_id == trader_user_id` => drop attribution).
- One-click can only attribute trades for same `event_id`.
- Click validity window: default 30 minutes (configurable).
- Attribution consumed per dedupe episode (see below), not per raw click.

### 1.2 Episode definition (anti-splitting)
Convert raw attributed market updates into episodes.

Episode key:
- `(trader_user_id, post_id, event_id, window_bucket)`

Window bucket:
- 15-minute buckets (configurable).

Meaningful update thresholds:
- `abs(new_prob - prev_prob) >= 0.01` OR `stake_amount_ledger >= 1_000_000` (1 RP)
- If below both thresholds => ignore for scoring.

Episode type classification:
- If user had prior position in event before update (see schema below) => `belief_update`
- Else => `attention_update`
- Both can score in v1; `belief_update` gets multiplier > `attention_update`.

Default multipliers:
- `belief_update = 1.0`
- `attention_update = 0.35`

### 1.3 Score computation per episode
For each episode, compute:

- `p_before = market prob before update`
- `p_after = market prob after update`
- `target_early = market consensus at t + 10% of remaining event lifetime`
- `target_mid = market consensus at t + 50% of remaining event lifetime`
- `target_final = resolved outcome prob (1 or 0) when resolved`

Proper-score delta:
- `Delta_h = LogLoss(target_h, p_before) - LogLoss(target_h, p_after)`

Horizon score with zero floor:
- `S_h = max(0, Delta_h)`

Combined episode score:
- `S_episode = r_u * m_episode * (0.2*S_early + 0.3*S_mid + 0.5*S_final)`

Where:
- `r_u = 1.0` in v1 (uniform reliability)
- `m_episode` is type multiplier (`belief` vs `attention`)

### 1.4 Post score and payout
Post score:
- Sum all finalized episode scores attributed to `post_id`.

Payout (per-score minting):
- `reward_ledger = floor(score * mint_rate_ledger_per_point)`

Safety caps:
- Max reward per post per event per day.
- Max reward per author per day.
- Max system mint per day (global circuit breaker).

Finalization:
- early/mid components awarded when horizon targets mature.
- Final component awarded only after event resolves.

## 2. Data Model and Schema Changes

### 2.1 New tables
1. `post_market_matches`
- `id`
- `post_id` FK posts
- `event_id` FK events
- `match_score` numeric
- `match_method` (`hybrid_v1`, future `hybrid_v2`)
- `created_at`
- unique `(post_id, event_id)`

2. `post_market_clicks`
- `id`
- `post_id`
- `event_id`
- `user_id`
- `clicked_at`
- `expires_at`
- `consumed_at` nullable
- `consumed_by_market_update_id` nullable FK market_updates
- index `(user_id, event_id, clicked_at desc)`

3. `post_signal_episodes`
- `id`
- `market_update_id` unique FK market_updates
- `post_id`, `event_id`, `trader_user_id`
- `episode_bucket_start`
- `episode_type` (`attention`, `belief`)
- `is_meaningful` bool
- `p_before`, `p_after`
- `s_early`, `s_mid`, `s_final` nullable
- `finalized_early_at`, `finalized_mid_at`, `finalized_final_at` nullable
- `combined_score`
- `created_at`, `updated_at`
- indexes on `(post_id)`, `(event_id)`, `(trader_user_id)`, `(episode_bucket_start)`

4. `post_signal_reward_payouts` (audit/idempotency)
- `id`
- `episode_id` FK post_signal_episodes
- `post_id`, `author_user_id`, `event_id`
- `component` (`early`, `mid`, `final`)
- `score_component`
- `mint_rate_snapshot`
- `reward_ledger`
- `payout_status`
- `created_at`
- unique `(episode_id, component)` for idempotency

### 2.2 Alter existing `market_updates`
Add nullable fields:
- `referral_post_id` FK posts
- `referral_click_id` FK post_market_clicks
- `had_prior_position` boolean default false

Rationale:
- keeps attribution tied to immutable trade records and simplifies scoring.

## 3. API and Interface Changes

### 3.1 Backend API (new)
1. `POST /api/posts/:postId/market-click`
- Body: `{ event_id }`
- Auth required.
- Validates `(post,event)` match exists.
- Writes `post_market_clicks` row.
- Returns `{ success: true }`.

2. `GET /api/posts/:postId/markets`
- Returns matched markets for rendering under post.

### 3.2 Backend API (existing route behavior change)
`POST /api/events/:eventId/update`
- Before proxying to prediction-engine:
  - lookup latest unexpired `post_market_clicks` for `(user,event)`
  - validate self-referral exclusion
  - pass server-validated referral context downstream
- No client-supplied referral accepted.

### 3.3 Prediction-engine contract change
`MarketUpdate` payload adds optional:
- `referral_post_id?: i32`
- `referral_click_id?: i32`

`UpdateResult` adds:
- `market_update_id: i32` (RETURNING id from insert)

Needed so backend can mark click consumed and build deterministic episode links.

## 4. Matching and Feed Integration

### 4.1 Matching engine v1
- Use PostgreSQL full-text match against event title/details as the baseline candidate prefilter.
- Trigger matching:
  - on post create/update
  - on event create/update (backfill recent posts)
- Keep top `N=3` matches above threshold.
- Keep reproducible baseline candidate selection so matching never blocks post flow.

#### 4.1a Agentic Retrieve-and-Reason Match Pipeline (optional, non-breaking)
Goal: improve match quality without changing reward payout logic.

Flow:
1. **Gate (cheap model, optional)**: classify if post contains a future-facing claim and infer a simple domain.
2. **Retrieve (hybrid DB, required)**: candidate markets via pgvector + BM25/TSVector.
3. **Reason (expensive model, optional)**: rank candidates + extract best match + stance and critique notes.
4. **Attach**: persist candidate ranking and selected market suggestion.
5. **Verify (human-in-the-loop)**: author/reviewer confirmations are captured as labels, not auto-authority.

Policy:
- Scope separation:
  - `post_market_matches`: display candidates/selection that may drive UI suggestions.
  - `post_market_clicks`/`referral_*` still drives scoring and payouts.
- Safety:
  - optional feature flag (`POST_SIGNAL_AGENTIC_MATCH_ENABLED`) must be on to call any model.
  - strict timeout + candidate cap (default 15) + budget guardrails.
  - no fallback `match_method` is used; reasoner misses or failures keep the existing hybrid-run candidates and continue without hard errors.
- Existing users and existing rows stay valid; fields are additive.

### 4.2 UI updates
- Under each post, render matched markets chip list.
- Click behavior:
  - call `POST /posts/:postId/market-click`
  - navigate user to market view.
- No reward-specific UI needed in first release beyond author-side "signal stats" page.

### 4.3 Optional non-breaking schema extension for agentic matching
These entities can be added later without touching reward payout tables:

- `post_analysis` (pipeline status + gate signal)
- `propositions`, `prop_relations` (argument graph extraction), no evidence span columns in v1
- `post_market_links` (author/reader-confirmed best market link)
- `conditional_flags` (market-to-market implication candidates)
- `post_critiques` (reasoning weakness flags)
- `verification_actions` (reader/author feedback as labels)

If introduced, they are:
- display/enrichment only,
- never used for payout math,
- populated asynchronously after post creation.

## 5. Scoring Jobs and Runtime

### 5.1 Nightly scorer job (new)
Batch job performs:
1. Build/refresh episodes from newly attributed `market_updates`.
2. Finalize early and mid components for mature episodes.
3. Write payouts idempotently (`post_signal_reward_payouts`) and credit author `rp_balance_ledger`.

### 5.2 Finalization on resolution
When event resolves:
- finalize `s_final` for unresolved final components.
- mint final payouts idempotently.

Implementation path:
- Add service module `postSignalScoringService`.
- Add admin route:
  - `POST /api/posts/signal/rewards/run` (mirrors market-question runner pattern).
- Add to existing weekly/manual cron docs and optional nightly cron service.

## 6. Abuse and Safety Controls (v1 hard requirements)

- Self-referral exclusion.
- Meaningful update threshold.
- Episode dedupe window.
- Per-post daily cap.
- Per-author daily cap.
- Global daily mint cap (hard stop).
- Minimum account requirements for rewarded authors:
  - account age >= X days (configurable)
  - email verified minimum (reuse verification tier).

Moderation integration:
- If post removed/flagged for manipulation, future payouts blocked.
- Optional clawback deferred to v1.1 (log but do not auto-debit in v1).

## 7. Testing and Acceptance Criteria

### 7.1 Unit tests
1. Attribution validation:
- accepts only unexpired click with same `(user,event)`.
- rejects self-referral.
- rejects mismatched event click.
2. Episode builder:
- dedupe by 15-min bucket.
- threshold filters dust.
- attention vs belief classification by prior position.
3. Score math:
- logloss delta correctness.
- zero-floor enforcement.
- horizon weighting.
4. Payout caps:
- per-post, per-author, global cap behavior.
5. Idempotency:
- rerunning jobs does not duplicate payouts.

### 7.2 Integration tests
1. End-to-end attributed reward:
- create post -> match event -> click -> trade -> nightly run -> payout row + author RP increment.
2. Unattributed trade:
- trade without click yields no episode.
3. Self-referral:
- author clicks own post and trades => no attribution.
4. Superseded information:
- positive early/mid but zero final still yields partial per design.
5. Resolution finalization:
- unresolved episodes gain final component only after event outcome set.
6. Conflict/retry safety:
- concurrent batch runs still produce single payout rows.

### 7.3 Performance tests
- nightly job runtime across realistic `market_updates` volume.
- indexes verified with explain plans for attribution lookup and episode scans.

## 8. Rollout Plan

1. **Phase A (shadow mode, no minting)**
- full attribution + episode + score computation
- store scores, no payouts
- monitor gaming patterns and score distribution for 2 weeks.

2. **Phase B (capped minting on)**
- enable payout with conservative mint rate and strict caps
- keep admin kill switch.

3. **Phase C (tuning)**
- tune thresholds, episode window, multipliers, mint rate.
- optionally introduce non-uniform `r_u` in v1.1.

Observability:
- metrics: attributed trade rate, episode counts, score distribution, payout totals, cap-hit frequency, flagged abuse counts.

## 9. Explicit Interfaces / Type Additions

### Backend DTOs
- `PostMarketClickRequest { event_id: number }`
- `PostMarketMatch { event_id, title, market_prob, match_score }`
- `SignalRewardRunResult { processed_updates, episodes_created, payouts_count, minted_ledger_total, capped_count }`
- `PostAnalysisStatus { post_id, has_claim, domain, processing_status, gate_latency_ms, reason_latency_ms, processing_errors }`
- `PostMarketLinkProposal { post_id, event_id, stance, confidence, source, reasoning_summary }`

### Prediction-engine DTO updates
- `MarketUpdate` add optional `referral_post_id`, `referral_click_id`
- `UpdateResult` add `market_update_id`

### Config additions
- `POST_SIGNAL_REWARDS_ENABLED=true`
- `POST_SIGNAL_INCLUDE_SELLS=true`
- `POST_SIGNAL_CLICK_TTL_MIN=30`
- `POST_SIGNAL_EPISODE_WINDOW_MIN=15`
- `POST_SIGNAL_FIRST_HORIZON_FRACTION=0.10`
- `POST_SIGNAL_SECOND_HORIZON_FRACTION=0.50`
- `POST_SIGNAL_MARKET_SNAPSHOT_FALLBACK=events.market_prob`
- `POST_SIGNAL_MIN_PROB_DELTA=0.01`
- `POST_SIGNAL_MIN_STAKE_LEDGER=1000000`
- `POST_SIGNAL_MINT_RATE_LEDGER_PER_POINT`
- `POST_SIGNAL_CAP_PER_POST_PER_DAY_LEDGER`
- `POST_SIGNAL_CAP_PER_AUTHOR_PER_DAY_LEDGER`
- `POST_SIGNAL_CAP_GLOBAL_PER_DAY_LEDGER`
- `POST_SIGNAL_BELIEF_MULTIPLIER=1.0`
- `POST_SIGNAL_ATTENTION_MULTIPLIER=0.35`
- `POST_SIGNAL_GLOBAL_DAILY_CAP_LEDGER`
- `POST_SIGNAL_DAILY_PANIC_FRACTION` (optional auto-disable threshold, e.g. 0.05)
- `POST_SIGNAL_AGENTIC_MATCH_ENABLED=false`
- `POST_SIGNAL_MATCH_GATE_ENABLED=false` (claim/domain classifier)
- `POST_SIGNAL_MATCH_REASONER_ENABLED=false`
- `POST_SIGNAL_MATCH_CANDIDATE_LIMIT=20`
- `POST_SIGNAL_MATCH_TIMEOUT_MS=4000`
- `POST_SIGNAL_MATCH_MODEL=gemini-2.5-flash-lite` (or equivalent)
- `POST_SIGNAL_REASON_MODEL=z-ai/glm-5` (or equivalent)
- `POST_SIGNAL_OPENROUTER_API_KEY` (if using OpenRouter)

## 10. Assumptions and Defaults Chosen

- Eligible scope: all posts with auto-match.
- Wrong-direction scoring: zero floor.
- Horizon weights: 0.2 / 0.3 / 0.5 (10%/50%/final).
- Reliability weighting: uniform in v1 (`r_u=1.0`).
- Funding: per-score minting with strict caps and kill-switch.
- Settlement cadence: nightly + final on resolution.
- v1 uses both buy/update and sell `market_updates` as attribution source (with side-aware zero-floor scoring and no double-counting).

Matching assumptions:
- Baseline candidate match generation (`post_market_matches`) remains always available.
- Optional agentic matching is additive and can be rolled out per environment.
- LLM matching/reasoning does not affect payout math and never replaces authoritative attribution records.

## 11. Future Feature (v2): Propositional Engine for Conditional Markets

This section is deferred. It builds on v1 without changing current reward math and is only activated via explicit feature flags after the v1 rollout.

### 11.1 Why this exists
- Conditional markets are hard to compose globally with a direct full joint AMM (combinatorial blow-up).
- Existing `events` + local LMSR pools already handle 1D/2D cases well.
- A propositional graph gives a practical way to propose and route only the conditional markets worth instantiating based on user demand signals from posts.

### 11.2 High-level concept
1. Keep existing flat markets as `events` (no separate market table yet).
2. Add structured propositions (canonical atomic claims) and map them to `events`.
3. Build conditional links between propositions/markets as explicit graph edges (`P -> Q`) from user-contributed, human-confirmed traces.
4. Run LMSR only on instantiated market edges; do not attempt full global joint market making.
5. In v2, this graph can drive:
   - richer retrieval context,
   - author-confirmed premise/conclusion proposals,
   - conditional market discovery/suggestion,
   - optional Friston-style weighting on persuasive-alpha at resolution-time only.

### 11.3 Proposed schema additions (non-breaking, additive)
- `propositions`:
  - canonical claim node, optional normalized fields and embeddings.
- `proposition_aliases` (optional):
  - alternate forms for the same canonical proposition.
- `post_logic_traces`:
  - user-proposed `{post_id, premise_proposition_id, conclusion_event_id, stance, source}`.
- `event_condition_sets`:
  - explicit conditional structure for 2D markets (`antecedent_proposition_id -> consequent_event_id` and relation metadata).
- `proposition_truth_states`:
  - resolved/derived boolean outcomes for resolved propositions, for v2 signal interpretation.
- `proposition_market_mappings`:
  - many-to-one / many-to-many links between proposition nodes and existing `events` to keep back-compat during migration.

### 11.4 v2 pipeline (candidate path)
- Gate returns `claim_summary` + entities (already planned for optional matching).
- Retrieval remains hybrid (vector + TSVector), now plus lightweight proposition lookup.
- Reasoner proposes proposition-to-market links in structured form.
- Frontend presents the extracted graph as a glass-box modal:
  - user confirms/edits propositions and conclusion mapping before publish.
- Confirmed traces are persisted and versioned for future ranking and reward experimentation.

### 11.5 Reward coupling strategy (v2 only)
- Keep v1 payout unchanged as canonical source-of-truth.
- In v2, optionally add multiplier overlays:
  - if a post has confirmed logic traces supporting an event update, apply bounded multipliers to existing post-score components.
  - all overrides are bounded, explainable, and toggleable per market/update.
- Do not migrate directly to “logic-only scoring”; use additive calibration first.

### 11.6 v2 rollout constraints
- Add feature flags: `POST_SIGNAL_PROPOSITION_ENGINE_ENABLED`, `POST_SIGNAL_LOGIC_CONFIRM_REQUIRED_FOR_MATCH`.
- Preserve legacy `match_method` values for compatibility, but new writes should use `hybrid_v1`.
- Add read-only mode for first deployment.
- Keep all existing schema and payout endpoints stable until v2 proves calibration and anti-gaming behavior.

### 11.7 Out-of-scope for v1
- No change to canonical reward formula.
- No mandatory user proof obligations beyond current attribution flow.
- No global conditional AMM in this stage.
