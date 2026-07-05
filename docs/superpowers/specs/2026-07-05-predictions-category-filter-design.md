# Predictions: category dropdown, title-only search, junk-event flagging

Date: 2026-07-05
Status: approved

## Problem

The predictions page has a single search field whose placeholder claims "title or
category" but the backend only ever matched title. A category filter is wanted,
but the `events.category` column is 98% `general` (the import sources provide no
category), `domain` is uniform, and `events.topic_id` only records import source.
The real categories live in the topic system: `event_topics` already holds
LLM-assigned topics for 1,334 of 2,744 events (Politics 478, Economics 382, …);
the rest were never backfilled. Separately, the imported markets include junk:
unserious/joke questions and individual match-betting markets.

## Decision summary

- Category dropdown backed by **topics** (`event_topics`), not `events.category`.
- Backfill the unprocessed events with the existing Gemma classifier, now on the
  Mac mini (`http://100.111.127.90:8011/v1`; the old debian host is gone and the
  backend's empty `GEMMA_URL` silently falls back to its dead IP).
- Same Gemma call also returns a **junk verdict**; junk events are hidden via a
  reversible flag column, never deleted.
- Junk = unserious/joke/meme markets and individual match/game/race betting
  ("Will X beat Y on <date>"). Substantive sports questions (league policy,
  Olympics relocation, doping) are kept.
- Search field becomes title-only; the dropdown is the category filter (no
  free-text category search).

## Backend

### Migration (`backend/migrations/`)

- `events.hidden_at TIMESTAMPTZ NULL` — set when flagged as junk.
- `events.hidden_reason TEXT NULL` — `'llm: <short reason>'` for model verdicts,
  so manual hides are distinguishable.
- `events.llm_checked_at TIMESTAMPTZ NULL` — idempotence marker for the combined
  classify+junk call. The sweep processes `WHERE llm_checked_at IS NULL`, so the
  1,334 already-topic-classified events still receive a junk verdict.

### `gemmaClassifier.js`

- Prompt asks for one JSON object:
  `{"topics": ["slug", ...], "junk": true|false, "junk_reason": "<short>"}`
  with the junk definition above spelled out.
- Parser returns `{ topics, junk, junkReason }`; missing/invalid `junk` is
  treated as a failed verdict (topics may still be used).
- Default `GEMMA_URL` and comments updated debian → Mac mini.

### `topicService.classifyEventLLM`

On Gemma success (valid topics AND boolean junk):
- Replace `event_topics` rows with `llm`-sourced ones (unchanged).
- Set `llm_checked_at = now()`.
- If junk: `hidden_at = now()`, `hidden_reason = 'llm: <reason>'`.
- If not junk: clear `hidden_at`/`hidden_reason` **only when**
  `hidden_reason LIKE 'llm:%'` — manual hides are never clobbered.

On Gemma failure: embedding fallback for topics (unchanged); no junk verdict,
`llm_checked_at` stays NULL so the next sweep retries.

Sweep (`classifyUnclassifiedEventsLLM`) and the admin endpoint's pending count
switch their scope query to `llm_checked_at IS NULL`. Trigger stays
`POST /admin/topics/classify-unclassified` (admin JWT, 409 while running).

### `getEvents` (`predictionsController.js`)

- Adds `WHERE hidden_at IS NULL`.
- LEFT JOINs `event_topics`/`topics` and aggregates topic names into a `topics`
  text array per row (empty array when unclassified).
- `getEventById` unchanged: hidden events stay reachable by id, so deep links
  and any existing positions/history still resolve.

Known consequence: hidden events disappear from the client-side "My Positions"
filter. Accepted — approximately zero real predictions exist today, and the flag
is reversible with `UPDATE events SET hidden_at = NULL, hidden_reason = NULL
WHERE id = …`.

## Frontend (`EventsList.jsx`)

- Search input placeholder becomes "Search titles…"; behavior already
  title-only server-side.
- New `<select>` between search and status filter: default "All categories",
  then each topic present in the loaded events ordered by descending event
  count, labeled `Politics (478)`. Client-side filter: an event matches when
  any of its `topics` equals the selection. Multi-topic events count toward
  each topic. Chosen over a server-side `?topic=` param because the page
  already loads all events and filters client-side (status filter precedent);
  counts derive from loaded data for free.
- Events with an empty `topics` array appear only under "All categories".
- "Clear Filters" resets search, status, and category.
- Per-row category chip shows the event's topic names when present, falling
  back to the `category` text — rows stop uniformly saying "general".
- `.events-filters` gets `flex-wrap` so three controls behave on mobile.

## Ops / rollout

1. Set `GEMMA_URL=http://100.111.127.90:8011/v1` in `backend/.env` (main
   checkout; gitignored). Fixes live classification of newly created events too.
2. Merge branch, restart backend (migrations auto-run), trigger the admin
   endpoint. ~2.7k sequential Gemma calls ≈ 1.5–3 h background.
3. Post-sweep review: report count + sample of hidden events for a false-positive
   spot-check before closing out.

New events created via the UI flow through the same combined call, so junk
filtering and topic assignment are permanent behavior, not a one-time cleanup.

## Testing

- Backend (jest): combined-response parsing (fences, missing junk field);
  verdict handling — hide on junk, unhide only `llm:%` hides, manual hide
  preserved, `llm_checked_at` set only on full success; `getEvents` returns
  `topics` array and excludes hidden rows.
- E2E (Playwright): dropdown renders with topic options and counts; selecting a
  topic narrows the list; title search still filters; Clear Filters resets both.

## Out of scope

- Virtualization / DOM-size work (separate effort).
- Changes to `events.category`, importers, or the topics taxonomy.
- Admin review UI for hidden events (SQL is the interface).
