# Community Groups — Core (Sub-project A) — Design

**Date:** 2026-06-17
**Status:** Approved design, pending implementation plan

## Context & decomposition

"Social groups/communities" is large, so it's split into independently-shippable
sub-projects. This spec is **sub-project A only**.

A **group** is a user-created **narrow theme** (title + description) that lives
**under one of the 10 parent topics** (a subtopic — e.g. *"BTC $200k in 2026?"*
under Crypto), is **public**, and optionally pins specific markets later. It is
NOT one of the broad 10 topics, and NOT an MLS chat group (the existing
`mls_groups` are private E2EE chats — unrelated; we use distinct table names to
avoid collision).

Decomposition (each its own spec → plan → build):
- **A — Core (this spec):** create a group, join/leave, browse-by-topic, the
  group-page shell. The foundation.
- **B — Group feed:** post into a group; the Feed tab.
- **C — Group chat:** public realtime room (plaintext over Socket.io — public,
  so not MLS/E2EE); the Chat tab.
- **D — Pinned markets:** attach events/markets; the Markets tab.
- **E — Moderation:** reports, owner/mod tools (basic admin removal lands in A).

## Goal (sub-project A)

Let verified users create public theme-groups under a parent topic, let anyone
browse and join/leave them, and render a group page shell ready for the feed /
chat / markets tabs that follow.

## Decisions

- **Naming:** UI label "Groups". Tables/routes use `community_groups` /
  `community_group_members` and `/api/groups` (no collision with `mls_groups` /
  `/api/mls`).
- **Creation gate:** verification **tier ≥ 2** (phone or payment verified),
  reusing the existing verification middleware. The creator becomes **owner +
  first member**.
- **Duplicate handling:** soft, non-blocking — warn if a similar name exists,
  never hard-block.
- **Browse layout (chosen: B):** a single list of group cards, **sortable**
  (members / most recent), with **topic-filter tabs**; each card shows name,
  parent-topic chip, description, member count, Join.
- **Group page IA (approved):** header (name, topic chip, description, member
  count, Join/Leave, creator) then tabs **Feed / Chat / Markets** in that order.
  In A, Feed shows an empty placeholder and Chat/Markets are present but disabled
  ("Soon" / "Later"); their content ships in B/C/D.
- **Membership** is its own table (`user_topics` does not fit — groups are
  sub-entities, not topics).

## Data model (backend)

Migration `backend/migrations/20260617_community_groups.sql`:

- `community_groups`
  - `id SERIAL PRIMARY KEY`
  - `slug TEXT UNIQUE NOT NULL` (generated from name + short random suffix)
  - `name TEXT NOT NULL` (validated 3–80 chars)
  - `description TEXT NOT NULL DEFAULT ''` (≤ 500 chars)
  - `topic_id INT NOT NULL REFERENCES topics(id)`
  - `created_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `member_count INT NOT NULL DEFAULT 0` (denormalized; maintained on
    create/join/leave)
  - `removed_at TIMESTAMPTZ` (NULL = active; set on soft-delete)
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - index on `(topic_id)` and `(member_count DESC)` for browse.
- `community_group_members`
  - `group_id INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE`
  - `user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `role TEXT NOT NULL DEFAULT 'member'` (`'owner'` | `'member'`)
  - `joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - `PRIMARY KEY (group_id, user_id)`

## Endpoints (backend — `controllers/communityGroupsController.js`, routes in `routes/api.js`)

All under `/api`. Active = `removed_at IS NULL`.

- `GET /groups?topic=<id>&sort=members|recent&limit=<n>&cursor=<c>` — list active
  groups, optional topic filter, sorted by `member_count DESC` (default) or
  `created_at DESC`. Each row: `id, slug, name, description, topic_id,
  topic_name, member_count, created_by, is_member` (viewer membership; false when
  unauthenticated). Public (auth optional).
- `GET /groups/search?q=<text>&topic=<id>` — name-similarity matches (`ILIKE`),
  for the create-form duplicate warning. Public.
- `GET /groups/:slug` — one active group + `is_member`, `is_owner`, `topic_name`.
  404 if missing/removed. Public.
- `POST /groups` — create. **Auth + tier ≥ 2.** Body `{ name, description,
  topic_id }`. Validate (name length, description length, topic exists);
  generate unique slug; insert group (`created_by`, `member_count = 1`) + an
  `owner` membership row in one transaction. 201 with the group. 403 if tier < 2.
- `POST /groups/:id/membership` — join (auth). Upsert membership (`member`),
  `member_count += 1` only on a new row. Idempotent. Returns `{ is_member: true,
  member_count }`.
- `DELETE /groups/:id/membership` — leave (auth). Remove membership if present,
  `member_count -= 1` (floor 0). Owner may leave; the group persists (ownership
  stays via `created_by`). Returns `{ is_member: false, member_count }`.
- `DELETE /groups/:id` — soft-delete (auth; **owner or admin**). Sets
  `removed_at = NOW()`. 403 otherwise.

Member-count mutations happen in the same transaction as the membership change.

## Frontend (van skin)

- Routes (hash): `#groups` (browse), `#group/:slug` (detail). Add a **"Groups"**
  nav entry. `api.js` wrappers: `listGroups`, `searchGroups`, `getGroup`,
  `createGroup`, `joinGroup`, `leaveGroup`.
- `GroupsPage.jsx` (browse, layout B): topic-filter tabs (`All` + the 10
  topics from `GET /topics`), a sort toggle (Members / Recent), a list of
  `GroupCard`s (name, topic chip, description, member count, Join/Joined), and a
  **"+ New group"** button that opens the create form. Empty state per filter
  ("No groups in <topic> yet — start one").
- `GroupCard.jsx`: presentational; Join/Joined button calls join/leave and
  updates `is_member` + `member_count` optimistically.
- `CreateGroupForm.jsx`: Name, Topic (select of the 10), Description. Shown only
  to tier-≥2 users; others see a "Verify your account to create a group" notice
  with a link to verification. On name blur, calls `searchGroups` and shows the
  soft duplicate warning. On submit → `createGroup` → navigate to the new
  group's page.
- `GroupPage.jsx` (detail): the approved header (name, topic chip, description,
  member count, Join/Leave, "Created by @…"); a tab bar **Feed / Chat /
  Markets** where **Feed** is active and shows "No posts yet" placeholder, and
  **Chat**/**Markets** are disabled with "Soon"/"Later" labels (wired in B/C/D).

## Testing

- **Backend route tests** (`backend/test/community_groups.test.js`, mirrors
  `network_graph.test.js`): create requires tier ≥ 2 (403 for tier < 2, 201 for
  tier ≥ 2 with owner membership + `member_count = 1`); join increments and is
  idempotent; leave decrements (floor 0); `GET /groups?topic=` filters and
  returns `is_member`; `GET /groups/:slug` 404s on removed; soft-delete by
  owner/admin only; slug uniqueness.
- **Frontend:** browse/group pages are dynamic (out of the pixel visual net). A
  light Playwright smoke (authed tier-≥2 fixture): create a group → it appears in
  its topic filter → open it → Join/Leave toggles the member count.

## Out of scope (sub-project A)

- The Feed, Chat, and Markets tab *contents* (sub-projects B/C/D).
- Reporting / owner-mod tooling beyond owner/admin soft-delete (sub-project E).
- Editing a group after creation; transferring ownership; per-group settings.
- Hard duplicate blocking; rate limits beyond the tier-2 gate.

## Success criteria

- A tier-≥2 user can create a group under a topic and becomes owner + member;
  tier-<2 users are gated with a verify prompt.
- Anyone can browse groups (filter by topic, sort by members/recent) and
  join/leave; member counts stay correct.
- The group page renders the approved header + tab scaffold; removed groups 404.
- Backend route tests and the Playwright smoke pass.
