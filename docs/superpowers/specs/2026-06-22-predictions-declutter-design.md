# Predictions Page Declutter — Tabbed Shell + Expandable Markets List — Design

**Date:** 2026-06-22
**Status:** Approved direction
**Scope:** Frontend-only (van skin). No backend, no API, no DB migration.

## Goal

Declutter the van-skin `#predictions` page, which currently stacks three full
feature-blocks on one endless scroll (`EventsList` browse+detail, `MarketQuestionHub`
submit form, `LeaderboardCard`) and wastes a half-width "Select an Event" panel.
Replace it with a **Bauhaus tab shell** (Markets · Submit · Leaderboard · Admin)
where the **Markets** tab is a **single expandable events list** — click a row and
the forecasting controls fold inline (the old right-hand detail panel disappears).

Governing aesthetic: **van skin = Bauhaus modernist** — keep the centered ~600px
column and framing; refine within the existing tokens (`#0000ff` accent, 1px black
borders, 2px radius). No new colors, no widening, no right rail.

## Decisions (locked with the user)

- **Tabs:** Markets · Submit · Leaderboard, plus an **Admin** tab shown only when
  `isAdmin()`. Markets is the default.
- **Markets = one expandable list.** Delete the separate `.selected-event-container`
  right panel and the "Select an Event" placeholder. Clicking a row expands it
  inline to render today's `<MarketEventCard hideTitle>` (buy/sell/forecast UI).
- **Accordion: one row open at a time.** Clicking another row collapses the first;
  clicking an open row's header collapses it.
- **Weekly assignment** is pinned as the first row and auto-expanded, marked
  "Weekly · Pending/Completed".
- **RPBalance** stays in the page header, persistent above the tab bar (all tabs).
- **Richer rows:** full (non-truncated) title + probability, a thin Bauhaus
  probability bar, and a meta line: category · close date · forecaster count ·
  "You: <position>" when the viewer holds one. (Exact fields finalized at build
  time against available event data; degrade gracefully when a field is absent.)
- Titles no longer truncate — they wrap.

## Routing / state

- Active tab synced to the hash, reusing the existing `#predictions/<param>` route
  (`VanApp.jsx` passes `routeParam` → `PredictionsPage` as `marketId`):
  - `#predictions` → Markets (default)
  - `#predictions/submit` → Submit
  - `#predictions/leaderboard` → Leaderboard
  - `#predictions/admin` → Admin (admins only; non-admins fall back to Markets)
  - `#predictions/<numeric id>` → Markets tab with that event expanded
  (numeric ids vs. word keywords never collide).
- `PredictionsPage` gets an `activeTab` signal initialized from the hash; changing
  tabs updates the hash. A numeric param sets Markets + the expanded event.
- In `EventsList`, the `selectedEvent` "detail panel" concept becomes an
  `expandedEventId` (accordion). All existing data loading (`getEvents`,
  `getUserPositions`, `api.weekly.getUserStatus`) is unchanged — only **where** the
  selected/expanded event renders moves (inline, not a side panel).

## Components

- **`PredictionsPage.jsx`** — add the tab bar + `activeTab` (hash-synced); render
  the active tab's content. Move `AdminTools`/`AdminMarketResolution`/
  `AdminEventManagement` into the Admin tab. `RPBalance` stays in the header.
- **`EventsList.jsx`** — remove `.selected-event-container` + `renderSelectedEvent`
  placeholder branches; convert the `<li>` rows to richer, expandable rows that
  render `<MarketEventCard hideTitle>` inline when expanded; pin + auto-expand the
  weekly-assignment row. Keep header (search, filter, summary) and Refresh action.
- **`MarketQuestionHub.jsx`** — unchanged; rendered inside the Submit tab (keeps its
  own Submit / Review Queue / My Submissions sub-tabs).
- **`LeaderboardCard.jsx`** — unchanged; rendered inside the Leaderboard tab.
- **New (optional) `PredictionsTabs.jsx`** — a small presentational Bauhaus tab bar
  component if it keeps `PredictionsPage` clean; otherwise inline.
- **`styles.css`** — tab-bar styling (flat, 1px black, active = solid `#0000ff`
  block with black text, inactive = white), probability-bar styling (black outline,
  blue fill), expandable-row styling. Reuse existing van tokens only.

## Bauhaus styling

- Tab bar: geometric, flat, 1px black borders; active tab = solid primary-blue
  block, black text; inactive = white background, black text. No gradients/shadows
  beyond what the van skin already uses.
- Probability bar: thin, black-outlined track, primary-blue fill proportional to
  `market_prob`.
- Rows: 1px black borders, generous internal padding, full-width within the column.

## Error handling / edge cases

- Logged-out: Markets tab still browses (read-only); `MarketEventCard` already gates
  trading behind auth + the verification notice path (`onVerificationNotice`).
- No weekly assignment / not authed: simply no pinned row (no placeholder panel).
- Admin tab hidden for non-admins; direct `#predictions/admin` falls back to Markets.
- Empty/loading/error states for the list are preserved from current `EventsList`.

## Testing

- **Playwright smoke** (`tests/e2e/predictions-tabs.spec.js`): load `#predictions`
  → Markets is default and the list renders; click a row → `MarketEventCard`
  renders inline and other rows are collapsed (accordion); switch to Submit → the
  question form shows; switch to Leaderboard → the leaderboard shows; deep-link
  `#predictions/<id>` → Markets tab with that row expanded. Run against the
  van skin; keep assertions resilient (presence/role, not pixel-exact).
- No backend tests (no backend change).

## Revertibility

- Dedicated branch `predictions-declutter-tabs`; atomic commits (tab shell ·
  EventsList rewrite · styling · smoke test). Frontend-only, **no migration** → a
  `git revert` of the merge (or deleting the branch) fully undoes it. Terminal skin
  is a separate code path and is untouched.

## Out of scope

- Terminal/Bloomberg skin (separate code path).
- Virtualization / `pretext` (explicitly parked — lists aren't long enough yet).
- Any backend/API/schema change.
- Changes to `MarketEventCard` internals or `MarketQuestionHub` sub-tabs beyond
  rendering them in their new homes.

## Success criteria

- `#predictions` opens to a clean Markets tab: one scannable list, no empty
  side-panel, no truncated titles.
- Clicking a row reveals the forecasting controls inline; one row open at a time;
  weekly assignment pinned + auto-expanded.
- Submit, Leaderboard, and (admin-only) Admin live in their own tabs; tabs are
  deep-linkable; numeric deep-links expand the right market.
- Bauhaus styling reuses existing van tokens; nothing regresses in the van skin and
  the terminal skin is unaffected.
