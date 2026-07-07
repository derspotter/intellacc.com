# Positions Tab — Design

**Date:** 2026-07-07
**Branch:** predictions-positions-tab
**Status:** Approved by user in conversation ("yes go")
**Follows:** 2026-07-07-my-positions-section-design.md (shipped same day)

## Change

The My Positions section moves from the top of the Markets tab into its own
**POSITIONS** tab, which becomes the default tab for logged-in users. The
box no longer stretches to a fixed height.

## Requirements (user-stated)

1. "Make the box fit the contents" — the positions card currently inherits
   `.events-list-card { height: 780px }` (styles.css:3667) and
   `.events-simple-list { flex: 1 }` (styles.css:4264), drawing a mostly
   empty 780px border around two rows. The positions view must size to its
   rows.
2. "Own tab, standard tab when you open predictions."

## Design

### Tabs and routing (PredictionsPage.jsx)

- Tab order: **POSITIONS | MARKETS | SUBMIT | LEADERBOARD | ADMIN**.
- Hash mapping (`activeTab`):
  - `#predictions` → `positions` when authenticated, `markets` when not
    (anonymous users have no positions; empty default tab is useless).
  - `#predictions/markets` → markets (new reserved keyword).
  - `#predictions/positions` → positions (explicit).
  - `#predictions/<numeric id>` → markets + expand that market (unchanged).
  - `submit`, `leaderboard`, `admin` unchanged.
- `goToTab('markets')` now navigates to `predictions/markets`;
  `goToTab('positions')` navigates to plain `predictions` (it is the
  default), keeping URLs short for the common case. Logged-out users on
  plain `predictions` see markets.
- The POSITIONS tab button renders only when authenticated.

### MyPositions component (new file)

Extract the positions UI from `EventsList.jsx` into
`frontend-solid/src/components/predictions/MyPositions.jsx`:

- Owns its own `userPositions`/`positionsLoading`/`positionsError` state and
  fetch (`getUserPositions`), the `positionGroupsById`/`positionRowIds`
  memos, `expandedPositionIds`, `settledOutcomeText` — moved, not rewritten.
  The stable-primitive-id `<For>` pattern (46e0037) is preserved as-is.
- Tab content, so: no collapsible header — plain heading `My Positions (n)`
  (n = open count, as today); a real empty state replaces the
  render-nothing rule: "No open positions yet." with a link/button to the
  Markets tab; loading state shows a one-line "Loading positions…" (fixes
  the pop-in noted at review).
- Trading inside a card refreshes only the positions fetch (the component's
  own reload) — no `EventsList` coupling.
- Accepts `onVerificationNotice` prop from the page (same plumbing as
  EventsList).

### EventsList.jsx cleanup

- The my-positions section block, its signals/memos, and the section CSS
  hooks move out. EventsList keeps `loadUserPositions` ONLY to power the
  "Position" tag on market rows (`positionEventIds`, open positions only) —
  unchanged behavior.

### Box fit (styles.css)

- `.my-positions-card` stops reusing `events-list-card` sizing: it becomes
  its own block — `height: auto`, list not `flex: 1`, no `overflow` clamp.
  Rows keep the existing `event-list-item` look (borders, prob bar, tags).
  Dark-mode overrides carry over. Mobile media-query rules that targeted
  the section via `events-list-card` must be checked so the tab renders
  correctly at phone widths.

### Deep-link/back-compat

- Old bookmarks `#predictions` now land on Positions when logged in — this
  is the requested behavior, not a regression.
- `#predictions/<id>` market deep-links (used by notifications/feed links)
  keep working: markets tab + expansion.

### Testing

- `tests/e2e/my-positions-section.spec.js`: logged-in test asserts landing
  on `#predictions` shows the POSITIONS tab active with the section content
  (default-tab assertion), all existing assertions (unlisted tag, settled
  row, stale drop, buy updates + banner survives) adapted to the tab; the
  hidden-market-not-in-browse-list assertion switches to the Markets tab
  before checking. Logged-out test asserts `#predictions` lands on MARKETS
  and no POSITIONS tab button exists.
- `tests/e2e/predictions-tabs.spec.js`: update expected tab set/default
  (inspect and adapt existing assertions).
- `tests/e2e/predictions-pagination.spec.js`: runs logged out → lands on
  markets; should stay green unchanged (verify).
- Box fit: assert the positions card height is content-sized (e.g.
  `boundingBox().height` well under 780 with 2 rows), so the 780px
  regression cannot silently return.

## Out of scope

- Weekly assignment stays pinned on the Markets tab.
- Analytics/profile surfaces unchanged.
- Prod deploy = `docker restart intellacc_frontend_solid` (NOT compose
  restart from root; NOT verified via localhost:4174 — that is the dev
  container. Verify via https://intellacc.de).
