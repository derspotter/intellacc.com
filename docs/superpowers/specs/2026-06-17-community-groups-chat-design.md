# Community Groups — Chat (Sub-project C) — Design

**Date:** 2026-06-17
**Status:** Approved direction (sub-project C of the community-groups decomposition)

Builds on A (group core) and B (feed). **C fills the Chat tab:** a public,
real-time chat room per group.

## Goal

A live chat room on the **Chat** tab of `#group/:slug`. Public read; members
post. Real-time via the existing Socket.io, **plaintext (NOT MLS/E2EE)** — the
room is public, so end-to-end encryption doesn't apply.

## Decisions

- **Not MLS.** MLS (`mls_*`) is for private E2EE DMs. Group chat is a separate,
  plaintext `community_group_messages` table broadcast over Socket.io. No
  collision.
- **Membership to send; public to read** (matches the feed). Non-members see the
  history + live messages but get a "Join to chat" prompt instead of the input.
- **Transport:** send via REST `POST /groups/:id/messages` (easy to auth + test);
  the server inserts and broadcasts the new message to the Socket.io room
  `group-chat:<id>`; all clients in the room (including the sender) append on the
  `group-message` event. History via `GET /groups/:slug/messages`.
- v1: last 50 messages as history, newest at the bottom; no pagination/scrollback,
  no edit/delete (moderation is sub-project E), no typing indicators.

## Data model

Migration `backend/migrations/20260619_community_group_messages.sql`:
```sql
CREATE TABLE IF NOT EXISTS community_group_messages (
  id         SERIAL PRIMARY KEY,
  group_id   INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cgmsg_group ON community_group_messages (group_id, created_at);
```

## Backend

- `getGroupMessages` → `GET /api/groups/:slug/messages?limit` (optionalAuth,
  public): resolve active group (404 if missing); return the last `limit`
  (default 50, max 100) messages **chronological (oldest→newest)** as
  `{ messages: [{ id, user_id, username, content, created_at }] }` (join users
  for username). (Query newest-first with LIMIT then reverse, so we return the
  most-recent N in chronological order.)
- `postGroupMessage` → `POST /api/groups/:id/messages` (authenticateJWT):
  member-only (403 if not a member; 404 if group missing/removed); validate
  `content` non-empty and ≤ 1000 chars (400); insert; build the message row
  (with the sender's username); **broadcast** `req.app.get('io').to('group-chat:' +
  id).emit('group-message', message)`; respond 201 with `{ message }`.
- Socket handlers in `backend/src/index.js` `io.on('connection')`: add
  `socket.on('join-group-chat', (groupId) => socket.join('group-chat:' +
  Number(groupId)))` and `socket.on('leave-group-chat', (groupId) =>
  socket.leave('group-chat:' + Number(groupId)))`. (Public room — no membership
  check to *join/read*; membership is enforced on *send* via the REST route.)

## Frontend

- `frontend-solid/src/services/socket.js`: export `joinGroupChat(groupId,
  handler)` — ensures connected, `socket.emit('join-group-chat', groupId)`, and
  registers an `on('group-message', handler)`; and `leaveGroupChat(groupId,
  handler)` — `socket.emit('leave-group-chat', groupId)` + `socket.off('group-
  message', handler)`. (Follow the file's existing singleton/`connect()`
  pattern.)
- `frontend-solid/src/services/api.js`: `getGroupMessages(slug, { limit })` and
  `sendGroupMessage(groupId, content)`.
- `frontend-solid/src/components/groups/GroupChat.jsx` (NEW): props `group`. On
  mount: load history (`getGroupMessages`), `joinGroupChat(group.id, onMsg)`
  where `onMsg` appends (dedupe by id); `onCleanup` leaves + unsubscribes. Render
  a scrollable message list (`@username: content`, time) auto-scrolled to bottom,
  and — when `group.is_member` — a text input + Send (`sendGroupMessage`); else a
  "Join this group to chat" note. The sender's own message arrives via the
  broadcast (no optimistic add → no dupes).
- `GroupPage`: enable the **Chat** tab (remove the disabled state); when
  `tab() === 'chat'` render `<GroupChat group={group()} />`.

## Testing

- **Backend route test** (`backend/test/community_group_chat.test.js`): member
  posts a message (201, content echoed, has `username`); non-member 403; empty
  content 400; `GET /groups/:slug/messages` returns it in chronological order.
  (Socket broadcast isn't asserted in the route test — it's fire-and-forget; the
  REST insert + GET cover persistence.)
- **Smoke** (Playwright): a member opens the Chat tab, sends a message, sees it
  appear in the list. (Dynamic — out of the pixel net.)

## Out of scope (C)

- Pagination/scrollback beyond the last 50; edit/delete/moderation (sub-project
  E); typing indicators / read receipts / presence; rate limiting beyond the
  member gate; message reactions.

## Success criteria

- Members can chat in real time on a group's Chat tab; non-members read but are
  prompted to join; history (last 50) loads on open; messages broadcast live to
  everyone in the room.
- Backend route test + chat smoke pass; the Chat tab is enabled (no longer
  "soon").
