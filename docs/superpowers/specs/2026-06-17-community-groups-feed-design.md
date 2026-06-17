# Community Groups — Feed (Sub-project B) — Design

**Date:** 2026-06-17
**Status:** Approved direction (sub-project B of the community-groups decomposition)

Builds on sub-project A (shipped 2026-06-17). A is the group core (create / join /
browse / page shell with Feed/Chat/Markets tabs). **B fills the Feed tab:**
members post into a group, and the group page shows that group's posts.

## Goal

Let group members post into a group and read the group's feed on the **Feed**
tab of `#group/:slug`. Reuse the existing posts stack (`posts` table, `PostItem`,
`CreatePostForm`).

## Decisions

- A post belongs to **at most one** group via a nullable `posts.community_group_id`.
  A normal (global) post has it NULL; a group post sets it. The global home feed
  is unchanged (it shows all posts, group or not — see "Out of scope" for the
  hide-question).
- **Posting requires membership:** only members of a group may post into it
  (public read, member write). Non-members get 403.
- The group feed reuses **`PostItem`**; the composer reuses **`CreatePostForm`**
  (gated to members on the Feed tab).
- v1 pagination: newest-first, simple `limit` (default 30) + `before` cursor on
  `(created_at, id)`. No infinite-scroll polish required (a "Load more" button).

## Data model

Migration `backend/migrations/20260618_posts_community_group.sql`:
- `ALTER TABLE posts ADD COLUMN community_group_id INT REFERENCES community_groups(id) ON DELETE CASCADE;`
- `CREATE INDEX idx_posts_community_group ON posts (community_group_id, created_at DESC) WHERE community_group_id IS NOT NULL;`

(`ON DELETE CASCADE`: removing a group's row hard-deletes its posts. Since A
soft-deletes groups via `removed_at`, this cascade only fires on a true row
delete, which we don't do in v1 — acceptable.)

## Backend

- **`createPost` (`postController.js`)**: accept optional `community_group_id` in
  the body. When present: 400 if not an integer; load the group
  (`removed_at IS NULL`) → 404 if missing; verify the viewer is a member
  (`community_group_members`) → 403 if not; set `community_group_id` on the
  INSERT. When absent, behaviour is unchanged (NULL). A group post is a normal
  top-level post (not a comment); reject combining `community_group_id` with
  `parent_id`.
- **`getGroupPosts` (`communityGroupsController.js`)** → `GET /api/groups/:slug/posts?limit&before`:
  resolve the slug to an active group (404 if missing); return its posts
  newest-first with the fields `PostItem` needs:
  `p.id, p.user_id, u.username, u.avatar_url, p.content, p.image_url,
  p.created_at, p.like_count, p.comment_count`, plus
  `liked_by_user` (EXISTS for the viewer), and `repost_count` /
  `reposted_by_user` computed like the main feed (so the repost UI works).
  `optionalAuth` (public read; `liked_by_user`/`reposted_by_user` false when
  logged-out). Cursor: `before` = ISO `created_at` of the last row (with `id`
  tiebreak). Response `{ posts: [...], hasMore }`.
  - The reposted-post nested object and AI-flag fields are omitted; `PostItem`
    guards those with `<Show>` and treats missing repost fields as 0/false, so
    it degrades gracefully (group posts in v1 are plain authored posts).

## Frontend

- **`api.js`**: `getGroupPosts(slug, { limit, before })`; extend the post-create
  path to carry a group id — add `postToGroup(groupId, content, imageAttachmentId)`
  wrapper that calls `request('/posts', { method:'POST', body: { content,
  image_attachment_id, community_group_id: groupId } })`. (Leave the existing
  `createPost` wrapper untouched.)
- **`CreatePostForm`**: accept an optional `groupId` prop; when set, submit via
  `postToGroup(groupId, …)` instead of `createPost(…)`. Default (no prop) is
  unchanged.
- **`GroupPage` Feed tab**: when `tab === 'feed'`, render:
  - a `CreatePostForm groupId={group.id}` **only when `group.is_member`** (with a
    "Join to post" hint otherwise);
  - the group's posts via `<For>` over `PostItem`, loaded with `getGroupPosts`
    on first view of the tab; prepend a newly created post; a "Load more" button
    when `hasMore`.
  - empty state stays "No posts yet — be the first to post in this group."

## Testing

- **Backend route test** (`backend/test/community_group_feed.test.js`): a member
  posts into a group (201, post carries `community_group_id`); a non-member is
  403; `GET /groups/:slug/posts` returns the member's post (newest-first, with
  `like_count`/`liked_by_user` present); posting with `parent_id` +
  `community_group_id` is rejected.
- **Smoke** (extend or new Playwright): a member opens a group, posts on the Feed
  tab, sees it appear. (Group page is dynamic — out of the pixel net.)

## Out of scope (B)

- Hiding group posts from the global home feed (decision deferred; v1 keeps them
  visible globally — simplest, and they're public anyway).
- Comments/threads inside the group feed beyond what `PostItem` already renders.
- Per-group post moderation (sub-project E).
- Cross-posting a post into multiple groups.

## Success criteria

- A member can post on a group's Feed tab and immediately see it; non-members
  can read but are prompted to join to post.
- `posts.community_group_id` scopes the group feed; the global feed is unchanged.
- Backend route test + the Feed smoke pass; no regression to the main feed.
