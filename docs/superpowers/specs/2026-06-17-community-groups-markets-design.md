# Community Groups — Pinned Markets (Sub-project D) — Design

**Date:** 2026-06-17
**Status:** Approved direction (sub-project D of the community-groups decomposition)

Builds on A (core) / B (feed) / C (chat). **D fills the Markets tab:** the group
owner pins prediction markets (events) to the group; everyone sees them.

## Goal

The **Markets** tab of `#group/:slug` lists the markets pinned to the group
(title, probability, close date, link to the market). The owner can pin (search
→ pin) and unpin. This realizes the "theme + optional questions" model from the
groups brainstorm.

## Decisions

- **Owner-only pin/unpin** (the group's `created_by`, or an admin). Members and
  the public read the pinned list. (Mod tooling is sub-project E.)
- A pin references an existing **event** (`events.id`); no new market type. A
  pinned market card links to the existing market detail (`#predictions/:id`).
- Owner pins via **search** (type a title → results → Pin), reusing the existing
  `GET /events?search=` — avoids a giant dropdown (there are many events).
- v1: no ordering control (newest-pinned first), no per-pin note.

## Data model

Migration `backend/migrations/20260620_community_group_markets.sql`:
```sql
CREATE TABLE IF NOT EXISTS community_group_markets (
  group_id  INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  event_id  INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  pinned_by INT REFERENCES users(id) ON DELETE SET NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_cgmarkets_group ON community_group_markets (group_id, pinned_at DESC);
```

## Backend (`communityGroupsController.js`, routes in `api.js`)

- `getGroupMarkets` → `GET /api/groups/:slug/markets` (optionalAuth, public):
  resolve active group (404); return pinned events joined to `events`,
  newest-pinned first: `{ markets: [{ event_id, title, market_prob,
  closing_date, outcome }] }`.
- `pinGroupMarket` → `POST /api/groups/:id/markets` (authenticateJWT, **owner or
  admin**): body `{ event_id }`. 403 if not owner/admin; 404 if group missing;
  400 if `event_id` invalid; 404 if the event doesn't exist. Insert
  `ON CONFLICT (group_id, event_id) DO NOTHING`. Respond `{ pinned: true }`.
- `unpinGroupMarket` → `DELETE /api/groups/:id/markets/:eventId` (authenticateJWT,
  owner or admin): delete the row. Respond `{ pinned: false }`.
- Owner/admin check mirrors the existing `deleteGroup` (load `created_by`,
  compare to viewer, allow `req.user.role === 'admin'`).

## Frontend

- `api.js`: `getGroupMarkets(slug)`, `pinGroupMarket(id, eventId)`,
  `unpinGroupMarket(id, eventId)`. (Reuse existing `getEvents(search)` for the
  picker.)
- `components/groups/GroupMarkets.jsx` (NEW): props `group`, `isOwner`.
  - Loads `getGroupMarkets(group.slug)`; renders market cards: title, probability
    (`market_prob` → `xx%`), close date, a "View market" link to
    `#predictions/:event_id`. Resolved markets show their outcome.
  - When `isOwner`: a "Pin a market" search box — type → `getEvents(text)` → show
    up to 5 matches each with a Pin button (`pinGroupMarket` → refresh + clear);
    and each pinned card shows an Unpin button (`unpinGroupMarket` → refresh).
  - Empty state: "No markets pinned yet." (+ owner hint to pin one).
- `GroupPage`: enable the **Markets** tab (remove disabled state); render
  `<GroupMarkets group={group()} isOwner={group().is_owner} />` when
  `tab() === 'markets'`.

## Testing

- **Backend route test** (`backend/test/community_group_markets.test.js`): owner
  pins an event (then `GET …/markets` returns it with `title`); a non-owner pin
  is 403; pinning a nonexistent event is 404; unpin removes it; double-pin is
  idempotent.
- **Smoke** (Playwright): owner opens Markets tab, searches + pins an event, sees
  the market card; unpins it. (Needs a seeded event — create one via the test DB
  or the events API.)

## Out of scope (D)

- Members (non-owner) pinning; pin ordering/curation; per-pin commentary;
  creating markets from within a group; surfacing group-pinned markets elsewhere.

## Success criteria

- Owner pins/unpins markets via search; the Markets tab lists pinned markets with
  probability + close date + a working link to the market; non-owners read only.
- Backend route test + markets smoke pass; Markets tab enabled (no longer
  "later").
