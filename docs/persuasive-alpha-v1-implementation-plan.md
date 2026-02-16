# Persuasive Alpha v1: Truth-Weighted Marginal Information Scoring for Posts

## Summary
Implement a production-safe, attribution-backed reward system for high-signal posts using the agreed model:

- Scope: all posts with auto market matching
- Signal metric: marginal information value from attributed trade episodes
- Horizon mix: 24h / 7d / final = 0.2 / 0.3 / 0.5
- Wrong-direction handling: zero floor (no negative score in v1)
- Payout model: per-score minting (with hard caps)
- Settlement: nightly batch + final on event resolution
- Reliability: uniform initial user weights in v1 (`r_u = 1.0`)

This plan is tailored to current code reality:
- No existing post->trade attribution chain exists yet.
- `market_updates` currently records buy/update trades; sell-side rows are not recorded.
- Existing reward runner pattern exists (`market-questions/rewards/run`) and should be reused.

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
- `(trader_user_id, post_id, event_id, side, window_bucket)`

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
- `target_24h = market consensus at t + 24h`
- `target_7d = market consensus at t + 7d`
- `target_final = resolved outcome prob (1 or 0) when resolved`

Proper-score delta:
- `Delta_h = LogLoss(target_h, p_before) - LogLoss(target_h, p_after)`

Horizon score with zero floor:
- `S_h = max(0, Delta_h)`

Combined episode score:
- `S_episode = r_u * m_episode * (0.2*S_24h + 0.3*S_7d + 0.5*S_final)`

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
- 24h/7d components awarded when horizon matures.
- Final component awarded only after event resolves.

## 2. Data Model and Schema Changes

### 2.1 New tables
1. `post_market_matches`
- `id`
- `post_id` FK posts
- `event_id` FK events
- `match_score` numeric
- `match_method` (`fts_v1`, future `hybrid_v2`)
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
- `s_24h`, `s_7d`, `s_final` nullable
- `finalized_24h_at`, `finalized_7d_at`, `finalized_final_at` nullable
- `combined_score`
- `created_at`, `updated_at`
- indexes on `(post_id)`, `(event_id)`, `(trader_user_id)`, `(episode_bucket_start)`

4. `post_signal_reward_payouts` (audit/idempotency)
- `id`
- `episode_id` FK post_signal_episodes
- `post_id`, `author_user_id`, `event_id`
- `component` (`24h`, `7d`, `final`)
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
- Use PostgreSQL full-text match against event title/details.
- Trigger matching:
  - on post create/update
  - on event create/update (backfill recent posts)
- Keep top `N=3` matches above threshold.

### 4.2 UI updates
- Under each post, render matched markets chip list.
- Click behavior:
  - call `POST /posts/:postId/market-click`
  - navigate user to market view.
- No reward-specific UI needed in first release beyond author-side "signal stats" page.

## 5. Scoring Jobs and Runtime

### 5.1 Nightly scorer job (new)
Batch job performs:
1. Build/refresh episodes from newly attributed `market_updates`.
2. Finalize 24h and 7d components for mature episodes.
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
- positive 24h/7d but zero final still yields partial per design.
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

### Prediction-engine DTO updates
- `MarketUpdate` add optional `referral_post_id`, `referral_click_id`
- `UpdateResult` add `market_update_id`

### Config additions
- `POST_SIGNAL_CLICK_TTL_MIN=30`
- `POST_SIGNAL_EPISODE_WINDOW_MIN=15`
- `POST_SIGNAL_MIN_PROB_DELTA=0.01`
- `POST_SIGNAL_MIN_STAKE_LEDGER=1000000`
- `POST_SIGNAL_MINT_RATE_LEDGER_PER_POINT`
- `POST_SIGNAL_CAP_PER_POST_PER_DAY_LEDGER`
- `POST_SIGNAL_CAP_PER_AUTHOR_PER_DAY_LEDGER`
- `POST_SIGNAL_CAP_GLOBAL_PER_DAY_LEDGER`
- `POST_SIGNAL_BELIEF_MULTIPLIER=1.0`
- `POST_SIGNAL_ATTENTION_MULTIPLIER=0.35`

## 10. Assumptions and Defaults Chosen

- Eligible scope: all posts with auto-match.
- Wrong-direction scoring: zero floor.
- Horizon weights: 0.2 / 0.3 / 0.5 (24h/7d/final).
- Reliability weighting: uniform in v1 (`r_u=1.0`).
- Funding: per-score minting with strict caps.
- Settlement cadence: nightly + final on resolution.
- v1 uses buy/update-side `market_updates` as attribution source; sell-side attribution deferred unless sell logging is added.
