# Follower / Following Lists v2 — Design

**Date:** 2026-06-14
**Status:** Approved direction (part 2 of the social-graph UX decomposition)

**Part 2 of 3** of the social-graph UX work (part 1 = #network exploration
controls, shipped 2026-06-14; part 3 = repost surfacing). Ships independently.

## Goal

Complete the "browse and manage your follows" loop. The roadmap item is
"follower/following list pages" — but the Profile page **already** has working
Followers / Following tabs with lists, empty states, and click-to-profile. The
real gap is that each row is a **bare username button**: it carries no signal and
offers no action. You cannot tell who is worth following, and you cannot follow
back / unfollow without navigating to each profile.

So part 2 is not new routes (dedicated pages would only shadow the existing
profile tabs). It is upgrading the existing rows to be **informative** (accuracy
+ follower count, consistent with the #network graph) and **actionable**
(per-row Follow / Unfollow).

## Current state

- `GET /api/users/:id/followers` and `/following` (both `authenticateJWT`) return
  only `[{ id, username }]`.
- `ProfilePage.jsx` "Network" card: tabs toggle `activeNetworkTab`; each list is
  `<For>` over `followers()` / `following()` rendering a `.notification-link`
  button (username only → `#user/<id>`). Empty states already present. Data is
  loaded on demand via `loadNetworkData` (a "Load Network Data" button).
- `followUser`/`unfollowUser` API wrappers already exist; the profile-level
  follow button uses them via `toggleFollow`.

## Approach

Enrich the two list endpoints with the same per-user signal the graph already
computes, plus a viewer-relative `is_following` flag; then render richer,
actionable rows. No new routes, no schema change.

## Components

### 1. Backend — `userController.getFollowers` / `getFollowing`

Replace the bare `SELECT u.id, u.username` with the network-graph enrichment
pattern (`getNetworkGraph`, same file) applied to the follow-filtered set:

- `followers` — `COALESCE(fc.followers, 0)::INT` via a `follows GROUP BY
  following_id` subquery.
- `accuracy_percent` — `ROUND((100.0 * COUNT(p.id) FILTER (WHERE
  LOWER(COALESCE(p.outcome,'')) = 'correct') / NULLIF(COUNT(p.id) FILTER (WHERE
  p.outcome IS NOT NULL), 0))::NUMERIC, 1)::DOUBLE PRECISION` (NULL when the user
  has no resolved predictions — same as the graph).
- `is_following` — `EXISTS (SELECT 1 FROM follows vf WHERE vf.follower_id =
  $viewer AND vf.following_id = u.id)`, where `$viewer = getViewerId(req)`. This
  is **viewer-relative**: when I view someone else's follower list it tells me
  whom *I* already follow (enables follow-back / discovery); when I view my own
  Following list every row is `true`.
- Keep `WHERE ... AND u.deleted_at IS NULL`, `GROUP BY u.id, u.username,
  fc.followers`, and the existing array response shape (the frontend
  `extractRows` already accepts a bare array).

`getFollowers`: `JOIN users u ON f.follower_id = u.id WHERE f.following_id = $1`.
`getFollowing`: `JOIN users u ON f.following_id = u.id WHERE f.follower_id = $1`.

### 2. Frontend — `components/profile/NetworkUserRow.jsx` (NEW)

A small presentational row: username link (→ `#user/<id>`), a meta span
(`{accuracy}%` when non-null, `{followers} followers`), and a Follow/Unfollow
button shown only when `canFollow` and the row is not the viewer. Props:
`user`, `viewerId`, `canFollow`, `busy`, `onToggleFollow(user)`. Stateless;
the parent owns the async + signal updates.

### 3. Frontend — `ProfilePage.jsx`

- Replace both `<For>` row buttons with `<NetworkUserRow>`.
- Add `togglingId` signal; `toggleRowFollow(user)` calls `unfollowUser`/
  `followUser` based on `user.is_following`, then updates the matching row's
  `is_following` in **both** `followers()` and `following()` signals (a user can
  appear in both lists). Errors surface via the existing `setActionError`.
- `canFollow = isAuthenticated()`; per-row `busy = String(togglingId()) ===
  String(user.id)`; `viewerId = getCurrentUserId()`.

### 4. CSS — `styles.css`

`.network-user-row` (flex row, name left, meta + button right), `.network-user-meta`,
`.network-user-accuracy`, `.network-user-followers`, `.network-user-follow`
(reusing the existing `.follow-button` look where reasonable). Consistent with
the van skin; scoped so it doesn't leak to the terminal skin or analytics page.

## Testing

- **Backend route test** (`backend/test/followers_enriched.test.js`, mirrors
  `network_graph.test.js`): create alice/bob/carol; bob→alice, carol→alice,
  alice→bob. `GET /users/:alice/followers` as alice returns bob & carol with a
  numeric `followers`, an `accuracy_percent` key, and `is_following === true` for
  bob (alice follows bob) and `false` for carol. Cleanup deletes the users.
- **Manual / solid-local check**: load a profile's Network card, open both tabs,
  confirm metadata renders and Follow/Unfollow toggles a row and persists across
  a tab switch. (Profile network tab is dynamic/on-demand, so it stays out of the
  pixel visual net, as established.)

## Out of scope (v2)

- Dedicated `#followers` / `#following` routes (profile tabs already browse).
- Pagination / infinite scroll (current lists are small; revisit with scale).
- Avatars in rows (separate polish).
- Repost surfacing — part 3.

## Success criteria

- Both endpoints return `followers`, `accuracy_percent`, `is_following` per row.
- Rows show accuracy + follower count and a working Follow/Unfollow that updates
  immediately and stays correct across tab switches.
- Backend route test passes; van-skin visual net unaffected.
