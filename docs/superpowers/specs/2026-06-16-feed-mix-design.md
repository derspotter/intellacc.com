# Feed Mix — Configurable Feed Ranking — Design

**Date:** 2026-06-16
**Status:** Approved design, pending implementation plan

## Goal

Let users shape their own home-feed ranking with four weights — **prediction
accuracy, followers, likes, views** — set via four Windows-XP-volume-style
vertical sliders that always sum to 100%. Dragging one slider redistributes the
remaining budget proportionally among the others; individual sliders can be
**locked** so they don't move. The weights persist per user; the home feed
reorders client-side (instantly, no server round-trip) when it loads.

## Decisions (from brainstorming)

- **Liveness:** client-side reorder of the *loaded* posts (not server-side
  ranking of the whole pool). Weights persist for next visit.
- **Placement:** the slider panel lives in **Settings** (sliders + Save). No
  in-Settings preview; the home feed reorders on open from saved weights.
- **Signals (mixed author/post level):**
  - Accuracy → the **post author's** forecast accuracy %.
  - Followers → the **author's** follower count.
  - Likes → the **post's** `like_count`.
  - Views → the **post's** view count (rows in `user_post_views`).
- **Opt-in:** no saved weights → feed stays chronological (today's behavior).
  Saving weights opts in. Guarantees no regression for users who never touch it.
- **Visual:** van-skin card (League Spartan, 1px black borders, 2px radius,
  `#0000ff` fills, square white thumbs, locked = centered SVG checkmark). The
  approved mockup is the v3 visual companion screen.

## Architecture

```
Settings page                         Home feed
┌ FeedMixPanel.jsx ┐                  ┌ feed store ┐
│ 4 vertical sliders│  PUT weights →  │ loads weights (GET)
│ + locks + Save    │                 │ rankPosts(loaded, weights) on render
└──────┬───────────┘                  └──────┬─────┘
       │ redistribute() (pure)               │ rankPosts() (pure)
       └──────────── lib/feedRanking.js ──────┘
                         │
        GET/PUT /users/me/feed-weights  ← backend → user_feed_weights table
        getPosts payload + author_accuracy, author_followers, view_count
```

## Components

### 1. Pure logic — `frontend-solid/src/lib/feedRanking.js` (NEW)
No Solid/DOM imports, unit-tested with `node:test` (mirrors `graphFilters.js`).

- `redistribute(weights, locks, idx, newValue) → weights`
  - `weights` = `{accuracy, followers, likes, views}` integers summing to 100;
    `locks` = same keys → boolean; `idx` = the key being dragged; `newValue` =
    desired 0–100 for that key.
  - The dragged key clamps to `[0, 100 − sum(locked weights)]`.
  - Remaining budget `= 100 − sum(locked) − draggedValue` is split among the
    **unlocked, non-dragged** keys **proportionally to their current values**;
    if those are all 0, split equally.
  - Integer result via **largest-remainder rounding** so the sum is exactly 100.
  - If there are no unlocked non-dragged keys, the dragged key is pinned (returns
    weights unchanged except the clamp).
- `rankPosts(posts, weights) → posts` (new array, original not mutated)
  - Raw signal per post: `accuracy = author_accuracy` (0–100, may be null →
    treat as 0), `followers = author_followers`, `likes = like_count`,
    `views = view_count`.
  - Apply `Math.log1p` to the heavy-tailed counts (followers, likes, views);
    accuracy stays linear.
  - Min–max normalize each signal across the input posts to 0–1; if a signal's
    max == min, its normalized value is 0 for all (carries no ordering info).
  - `score = Σ (weights[k]/100) · norm[k]`.
  - Sort descending by score; **stable** tie-break preserving input order (which
    is the server's chronological order).
  - Empty input → empty array. A `null`/empty `weights` → return input unchanged.

### 2. Backend — persistence
- Migration `backend/migrations/20260616_user_feed_weights.sql`:
  `user_feed_weights(user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE
  CASCADE, w_accuracy SMALLINT NOT NULL, w_followers SMALLINT NOT NULL,
  w_likes SMALLINT NOT NULL, w_views SMALLINT NOT NULL, updated_at TIMESTAMPTZ
  NOT NULL DEFAULT NOW())`.
- `GET /users/me/feed-weights` (auth) → `{accuracy, followers, likes, views}` or
  `null` when no row.
- `PUT /users/me/feed-weights` (auth) → upsert; validate all four are integers
  0–100 and sum to exactly 100, else 400.
- Controller/routes follow existing patterns in `userController.js` /
  `routes/api.js`.

### 3. Backend — feed payload
Add three per-post fields to the two feed query blocks in
`postController.js` (the same blocks that compute `liked_by_user` /
`repost_count`), parameterized on the post/author:
- `view_count` = `(SELECT COUNT(*)::int FROM user_post_views WHERE post_id = p.id)`.
- `author_followers` = `(SELECT COUNT(*)::int FROM follows WHERE following_id = p.user_id)`.
- `author_accuracy` = the network-graph accuracy expression over the author's
  resolved predictions (`ROUND(100.0 * correct / NULLIF(resolved,0), 1)`),
  computed for `p.user_id`; `null` when the author has no resolved predictions.
- These are returned as-is (rows already flow through to the client). Add a code
  comment flagging the subqueries as a perf-watch: denormalize/cache author
  accuracy + follower count if the feed query slows at scale.

### 4. Frontend — UI
- `frontend-solid/src/components/settings/FeedMixPanel.jsx` (NEW) — the four
  van-skin vertical sliders + lock checkmarks (v3 visual), a Save button, and
  load/seed from `GET`. On drag it calls `redistribute`; Save calls the PUT
  wrapper. Default shown when no saved weights: equal `25/25/25/25` (saving is
  what opts in).
- Vertical slider: a small custom pointer-drag control (rotated native range
  inputs are unreliable), with `role="slider"`, `aria-valuenow`, and Up/Down
  arrow-key support (±1, Shift ±10).
- Mounted in the existing Settings page alongside other settings sections.
- Home feed store: load saved weights once, and apply `rankPosts(loadedPosts,
  weights)` whenever posts render or a new page is appended. When weights are
  null, render the server order unchanged.
- `frontend-solid/src/services/api.js`: `getFeedWeights()` and
  `saveFeedWeights(weights)` wrappers.

## Testing

- **`node:test`** `frontend-solid/src/lib/feedRanking.test.mjs`:
  - `redistribute`: proportional split of the freed budget; locked keys never
    change; dragged key clamps to `100 − sum(locked)`; sum is always exactly 100
    (incl. rounding cases like thirds); all-others-locked pins the dragged key;
    all-free-zero splits equally.
  - `rankPosts`: log+min–max normalization; weighting changes order as expected
    (e.g. accuracy=100 ranks the most-accurate author's post first); all-equal
    signal contributes nothing; stable tie-break on input order; empty input;
    null weights returns input unchanged.
- **Backend route test** (`backend/test/feed_weights.test.js`, mirrors
  `network_graph.test.js`): `PUT` rejects non-100 sums (400) and accepts a valid
  set; `GET` returns the saved weights; and a feed fetch (`GET /posts`) returns
  `author_accuracy`, `author_followers`, `view_count` on a post.

## Out of scope (v1)

- Persisting lock states (locks are interaction-only).
- Server-side ranking of the full candidate pool (only loaded posts reorder).
- Applying weights to the discover feed.
- An in-Settings live preview of reordered posts.

## Success criteria

- Setting weights in Settings persists them; reopening Settings restores them.
- The home feed visibly reorders (client-side) per saved weights on load; with no
  weights it is unchanged (chronological).
- Sliders always sum to 100; locks hold; dragging redistributes proportionally.
- `feedRanking` unit tests and the backend route test pass; no regression to the
  default feed.
