# Community Groups — Moderation (Sub-project E) — Design

**Date:** 2026-06-17
**Status:** Approved direction (final sub-project of the community-groups decomposition)

Completes community groups (A core, B feed, C chat, D markets). **E adds the
moderation surface** that user-created groups + member posting require.

## Goal

Keep groups safe: anyone can **report** a group (→ admin review via the existing
`moderation_reports`); a group **owner/admin** can **remove a post** from the
group feed and **remove (kick) a member**; a **Members** tab lists members.

## Decisions

- **Report a group:** any logged-in user (POST), recorded in the existing
  `moderation_reports` table (`reported_content_type = 'group'`,
  `reported_content_id = groupId`, `reported_user_id = group.created_by`). Admins
  see it through the existing `GET /admin/moderation/reports`. Use a dedicated
  `reportGroup` controller (don't overload the shared `createReport`, which has
  per-type validation). A user can't report their own group.
- **Remove a post:** owner-or-admin deletes a post that belongs to the group
  (hard delete — a group post has no other home; unlinking would leak it into
  the global feed). Reuses the `assertCanManage` helper from D.
- **Kick a member:** owner-or-admin removes a membership row (member_count−−);
  the **owner (`created_by`) cannot be kicked**.
- **Members tab:** a 4th tab on the group page listing members
  (owner first); owner/admin see a "Remove" button per non-owner member. (Extends
  the Feed/Chat/Markets IA with Members — a natural community page.)
- No new table — reuse `moderation_reports`, `posts`, `community_group_members`.

## Backend (`communityGroupsController.js`, routes in `api.js`)

- `listGroupMembers` → `GET /api/groups/:slug/members` (optionalAuth, public):
  `{ members: [{ user_id, username, role }] }`, owner first then by `joined_at`.
- `reportGroup` → `POST /api/groups/:id/report` (authenticateJWT): body
  `{ reason, details? }`. 404 if group missing; 400 if no reason; 400 if the
  reporter is the group's `created_by` ("can't report your own group"); insert
  into `moderation_reports` (reporter, reported_user_id = created_by,
  content_type 'group', content_id = groupId, report_reason, details). 201
  `{ reported: true }`.
- `removeGroupPost` → `DELETE /api/groups/:id/posts/:postId` (authenticateJWT,
  owner/admin via `assertCanManage`): verify the post exists AND its
  `community_group_id = groupId` (404/400 otherwise); `DELETE FROM posts WHERE id
  = $1`. `{ removed: true }`.
- `removeMember` → `DELETE /api/groups/:id/members/:userId` (authenticateJWT,
  owner/admin): 400 if target is the group's `created_by` ("can't remove the
  owner"); delete the membership row; if a row was deleted, `member_count =
  GREATEST(0, member_count − 1)` (same transaction). `{ removed: true,
  member_count }`.

## Frontend

- `api.js`: `getGroupMembers(slug)`, `reportGroup(id, reason, details)`,
  `removeGroupPost(id, postId)`, `removeGroupMember(id, userId)`.
- **Report**: in `GroupPage` header, replace the `⋯` placeholder with a
  **Report** button shown to logged-in non-owners → a small inline reason prompt
  (a text input + Submit) → `reportGroup` → "Reported, thanks" confirmation.
- **Remove post (owner)**: in the Feed tab, when `group.is_owner`, render a small
  **Remove** control above each `PostItem` (in the GroupPage feed list wrapper)
  → `removeGroupPost` → drop it from the list. (PostItem itself is unchanged.)
- **Members tab** (NEW, 4th tab): `components/groups/GroupMembers.jsx` — lists
  members (`@username` + role badge for owner); when `group.is_owner`, a
  **Remove** button on each non-owner member → `removeGroupMember` → refresh +
  update the header member count. Enable a `Members` tab button in `GroupPage`.

## Testing

- **Backend route test** (`backend/test/community_group_moderation.test.js`):
  a non-member reports a group (201; row in `moderation_reports` with type
  'group'); owner can't report own group (400); owner removes a member's post
  from the feed (200, gone from `GET …/posts`); a non-owner can't remove (403);
  owner kicks a member (member_count decremented; `GET …/members` no longer
  lists them); owner can't be kicked (400); `GET …/members` lists owner first.
- **Smoke** (Playwright): owner opens Members tab and removes a joined member; a
  user reports a group via the header Report control.

## Out of scope (E)

- Mod roles beyond owner (no co-moderators); banning (kick ≠ ban — a kicked user
  can re-join); in-app admin report-review UI beyond the existing
  `/admin/moderation/reports`; auto-moderation; appeal flow; report on individual
  group posts/messages (report targets the group in v1).

## Success criteria

- Any user can report a group; owners can remove posts and kick members; a
  Members tab lists members with owner-only Remove; member counts stay correct.
- Backend route test + moderation smoke pass; the group page exposes Report +
  Members; nothing regresses in A–D.
