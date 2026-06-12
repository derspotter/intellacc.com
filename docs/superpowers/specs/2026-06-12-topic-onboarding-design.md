# Topic Onboarding, Periodic Questions & Predictor Discovery — Design

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan

## Goal

Make topic preferences a first-class concept across the platform. Users pick
topics at login, get assigned weekly prediction questions from those topics
(with the existing stake/decay mechanic), and their feed surfaces posts from
accurate predictors in those topics — solving the cold-start problem where a
new user who follows nobody sees an empty feed.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Primary goal | Full vision: topics used across feed, assignments, discovery |
| Topic source | Curated list (~10) + automatic embedding classification |
| Classification quality | Validate embeddings against an LLM judge; gate before shipping |
| Weekly mechanic | Keep coercive version: 1% RP stake requirement, decay penalty on skip |
| Onboarding shape | Blocking topic picker after login (min 3 topics, no skip); no predictor step |
| Predictor discovery | The feed shows posts *by* top predictors in your topics, with follow buttons |
| Scheduler | Reuse existing `intellacc_weekly_cron` container (supercronic → admin API) |
| Validation judge | Local Qwen (`http://desktop:8004/qwen-json`); fallback `google/gemma-4-26b-a4b-it:free` via OpenRouter |

## 1. Data model

Migration (in `backend/migrations/`, replayable like the others):

- **`topics`** (existing table, extended): add `slug TEXT UNIQUE`,
  `embedding vector(768)`, `is_user_facing BOOLEAN NOT NULL DEFAULT FALSE`,
  `display_order INT`. The 2 existing import-bookkeeping rows stay
  `is_user_facing = false`.
- Seed ~10 user-facing topics: Politics, Geopolitics, Economics & Finance,
  AI & Technology, Science, Climate & Environment, Health, Sports,
  Culture & Media, Crypto. Each gets a one-paragraph description with example
  questions (used both in the picker UI and as embedding input).
- **`event_topics`**: `event_id INT REFERENCES events ON DELETE CASCADE`,
  `topic_id INT REFERENCES topics ON DELETE CASCADE`,
  `similarity REAL`, `source TEXT NOT NULL DEFAULT 'embedding'`,
  `PRIMARY KEY (event_id, topic_id)`. The `source` column allows swapping the
  classifier to `'llm'` later without schema change.
- **`user_topics`**: `user_id INT REFERENCES users ON DELETE CASCADE`,
  `topic_id INT REFERENCES topics ON DELETE CASCADE`, `created_at`,
  `PRIMARY KEY (user_id, topic_id)`. "User completed onboarding" ≡ has rows
  here; no separate flag.

## 2. Topic classification

- Topic embeddings: embed each topic's "Name. Description." once via the
  existing OpenRouter embedding service
  (`backend/src/services/openRouterMatcher/embeddingService.js`), store in
  `topics.embedding`.
- Event classification: cosine similarity via pgvector
  (`events.embedding <-> topics.embedding`). Assign top-1 topic always; also
  assign top-2 if its similarity is within a small margin of top-1 (exact
  threshold tuned empirically during backfill).
- Backfill script (idempotent) classifies all existing events; events missing
  embeddings get one generated first via the same service.
- Import pipeline hook: new events are classified immediately after their
  embedding is generated.

### Validation gate (must pass before the feature ships)

Dev-side script (not in any prod request path):

1. Sample ~100 classified events.
2. Ask the judge LLM to label each with up to 2 of the 10 topics.
   Judge: local Qwen via service-manager `POST /qwen-json`
   (`think: false`, `format: json`, `temperature: 0`); if the manager is
   unreachable, fall back to OpenRouter `google/gemma-4-26b-a4b-it:free`
   (model name env-configurable).
3. Report top-1 agreement and any-overlap rates as a markdown artifact.
4. **Gate: any-overlap ≥ 80% → ship embedding classification. Below →
   reconsider (likely flip `event_topics.source` to LLM-at-import).**

## 3. Onboarding gate

- After login, a user with zero `user_topics` rows sees a blocking,
  full-screen **topic picker** instead of any page content (van skin,
  `frontend-solid`). Applies equally to new and existing users. Logged-out
  browsing is unchanged.
- Picker: ~10 topic toggle buttons with short descriptions, "pick at least 3"
  counter, single Continue button. No skip. No predictor-suggestion step.
- Topics editable later in Settings via the same endpoint.

### API

- `GET /api/topics` — user-facing topics, ordered.
- `GET /api/users/me/topics` — own topic ids.
- `PUT /api/users/me/topics` `{ topicIds: int[] }` — replace own set;
  validates ≥ 3 user-facing ids.

## 4. Feed integration & top predictors

- **Ranking**: reuse the accuracy SQL already used by the network graph
  (`userController.js` `accuracy_percent`), filtered through `event_topics`,
  resolved predictions only, **min 5 resolved predictions in-topic** to
  qualify. If a topic yields < ~10 qualifying users, pad with globally
  accurate predictors.
- `GET /api/discover/predictors` — top predictors across the caller's topics.
- `GET /api/discover/feed` — recent posts authored by those top predictors
  (plus posts attributed to markets in the caller's topics, where post→market
  attribution exists).
- **HomePage behavior**: load the following-feed; if page 1 is empty, load
  `discover/feed` instead, with the notice
  *"Showing top predictors in your topics — follow people to make this feed
  yours."* In discover mode each post shows a **Follow** button next to the
  author. Following ≥ 1 person flips the next load back to the real feed.
- Low content volume in prod (25 posts) is acceptable; weekly assignments are
  the activity seed.

## 5. Weekly assignments

- `weeklyAssignmentService` event selection gains the topic constraint:
  assigned event must be open (closing date beyond week end), not already
  predicted by the user, and in one of the user's topics; fall back to any
  open event only when the user's topics have no eligible events.
- Stake/penalty mechanics unchanged (1% RP stake requirement, decay on skip).
- Scheduling unchanged: existing `intellacc_weekly_cron` container
  (supercronic, Monday 02:00 UTC → `weekly_cron.js` → `/weekly/run-all`).
- Surface: weekly-assignment card on the home page above the feed
  ("Your weekly question: … — stake by Sunday") in addition to the existing
  predictions-page UI and socket notification.

### Known issue to diagnose during implementation

The weekly cron has been firing for weeks but `weekly_user_assignments` has
zero rows ever. Possible causes: admin auth env vars missing in the cron
container, eligibility rules filtering all users, silent error. Diagnosing
and fixing this is an explicit implementation task — periodic assignments
actually running in prod is half the feature.

## 6. Testing

- **Jest (backend)**: topics endpoints; ≥3 validation; onboarding-gate query;
  topic-filtered assignment selection (incl. fallback); discover feed
  fallback; predictor ranking with fixtures (min-5 rule, padding).
- **E2E (Playwright)**: fresh signup → blocked by topic picker → pick 3 →
  lands on home with discover feed and follow buttons → follow someone →
  feed switches to following-feed.
- **Validation harness**: agreement report reviewed by Justus before rollout
  proceeds past step 2.

## 7. Rollout order

1. Migration + topic seed + topic embeddings + event backfill (idempotent
   script).
2. Run validation harness → review report → **gate decision**.
3. Backend endpoints + onboarding gate + feed fallback (+ jest tests).
4. E2E spec.
5. Verify/fix the existing weekly cron run end-to-end in prod (diagnose the
   zero-assignments issue, enable topic-aware selection).

## Amendment (2026-06-12): gate outcome — classification flipped to LLM

The validation gate FAILED for embedding-centroid classification (57% any-overlap,
44% top-1 vs Qwen judge; report: `docs/superpowers/reports/2026-06-12-topic-validation.md`).
Root causes: single centroid per topic is too crude for broad topics, and the
crypto topic description contained generic market phrasing that magnetized
stock-price questions (398/786 events → crypto).

Decision (Justus): classify with OpenRouter `google/gemma-4-26b-a4b-it:free`
(model env-configurable) instead.

- `topicService` gains an LLM classifier writing `source='llm'` rows (replacing
  that event's previous topic rows); the embedding classifier remains as
  fallback when the LLM call fails.
- Import hook and backfill use LLM-first classification.
- Topic descriptions get cleaned of generic market phrasing anyway (fallback
  hygiene); topic embeddings regenerated.
- The validation gate re-runs with Qwen as the (independent) judge against
  `source='llm'` data; same ≥80% any-overlap threshold.
- Contingency: OpenRouter free-tier daily caps may throttle the 786-event
  backfill; if so, the bulk backfill runs host-side against local Qwen while
  import-time classification stays on Gemma.

## Out of scope

- Topic-filtered feed browsing/tabs for users who already follow people.
- LLM classification at import (only as fallback if the gate fails).
- Suggested-follows UI panels outside the feed.
- Per-topic leaderboards (per-topic accuracy lands in SQL; UI later).
