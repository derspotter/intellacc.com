# Repost Surfacing — Design

**Date:** 2026-06-14
**Status:** Approved direction (part 3 of the social-graph UX decomposition)

**Part 3 of 3** of the social-graph UX work (part 1 = #network controls; part 2 =
actionable follower/following lists). Ships independently.

## Goal

Make reposts a first-class, visible engagement signal in the feed. The repost
*mechanism* already exists end-to-end — `posts.repost_id`, recursive
repost-chain hydration, a create-with-`repost_id` path, and a PostItem that
renders the quoted "Reposted from <user>" card with a Repost button. What's
missing is **surfacing**: unlike likes (`like_count` + `liked_by_user`) and
comments (`comment_count`), a post exposes **no repost count and no viewer
state**, and the Repost button is a fire-and-forget control using blocking
`confirm()`/`alert()` dialogs.

## Current state

- Feed queries (`getPosts`, and the second feed builder) return `p.*`
  (incl. `like_count`, `comment_count`) plus a `liked_by_user` CASE subquery and
  the `reposted_post` row. No repost count / viewer flag.
- `getPostById` is a minimal single-post fetch (already lacks `liked_by_user`
  and `username` — a pre-existing degraded path).
- `PostItem.handleRepost` calls `feedStore.createPost('', null, null, post().id)`
  wrapped in `confirm()` + `alert()`; the button always reads "Repost".

## Approach

Add the missing count + viewer flag with the same SQL idiom likes already use,
then render them and replace the dialog-based action with an optimistic,
one-way toggle (mirroring `handleLike`). No schema change (reposts are just
posts with `repost_id`; posts are hard-deleted, so a live `COUNT` is accurate).

## Components

### 1. Backend — feed queries + `getPostById` (`postController.js`)

After the existing `liked_by_user` CASE in **both** feed query blocks, add:
- `repost_count` — `(SELECT COUNT(*)::int FROM posts rpc WHERE rpc.repost_id = p.id)`.
- `reposted_by_user` — `EXISTS (SELECT 1 FROM posts rpu WHERE rpu.repost_id = p.id
  AND rpu.user_id = $1)` (viewer-relative).

Add the same two columns to `getPostById` (viewer param `$2`) for consistency.
Rows are returned as-is, so the fields flow through without extra mapping.

### 2. Frontend — `PostItem.jsx`

- Signals `repostCount`, `repostedByUser`, `repostBusy`; initialize
  `repostCount`/`repostedByUser` from the post in the same `createEffect` that
  seeds `likeCount`.
- `repostText()`: "Repost" / "Reposted", with `(N)` appended when `repostCount > 0`.
- Rewrite `handleRepost`: require auth (inline `setActionError` if not), no-op when
  already reposted/busy; optimistically set `repostedByUser` + bump count +
  `applyPostPatch`, call `feedStore.createPost('', null, null, post().id)`, roll
  back on failure. No `confirm()`/`alert()`.
- Repost button: `classList={{ reposted: repostedByUser() }}`, `disabled` when
  reposted or busy, label `{repostText()}`.

### 3. CSS — `styles.css`

`.post-action.repost-button.reposted` in the primary tone (mirrors `.liked`), and
keep it full-opacity when `:disabled` so the "Reposted" state reads as active, not
greyed-out.

### 4. Harness fixtures — `_harness/postItemFixtures.js`

Add `repost_count: 0` / `reposted_by_user: false` to BASE; set
`reposted_by_user: true` on one fixture and `repost_count: 42` on the
high-engagement fixture so the visual harness covers all three button states.
Regenerate the baseline.

## Testing

- **Backend route test** (`backend/test/repost_surfacing.test.js`): author posts,
  reposter reposts; `GET /posts/:id` shows `repost_count` 0→1 and
  `reposted_by_user` true for the reposter / false for the author.
- **Visual harness**: updated baseline shows "Repost", "Reposted" (active,
  disabled), and "Repost (42)".

## Out of scope (v1)

- Un-repost (toggle off) — needs a delete path for the viewer's repost row;
  reposting is one-way for now (button disables after).
- Twitter-style "X reposted" header above the original (vs the current quote
  card) — the quote card stays.
- Backfilling `getPostById`'s other missing fields (`username`, `liked_by_user`).

## Success criteria

- Feed posts expose `repost_count` + `reposted_by_user`; PostItem shows the count
  and a viewer-aware Repost/Reposted button that updates optimistically.
- Backend route test passes; the harness baseline reflects the three states.
