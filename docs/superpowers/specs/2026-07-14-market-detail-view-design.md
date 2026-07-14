# Market Detail View — Design

**Date:** 2026-07-14
**Status:** Approved for planning

## Problem

On the predictions page (Markets tab), the list of open questions lives inside a
fixed-height card (780px) with an inner scrollbar. Selecting a prediction expands
it inline as an accordion row, so the full trading UI is squeezed inside that
small scroll box. Selecting a prediction should instead display it in full.

## Decision

Route-driven detail view. Selecting a prediction navigates to
`#predictions/<id>`, which renders a full detail view in place of the list —
inside the normal page column (nav, RP balance header, and tabs stay put).
The inline accordion is removed.

## Routing

- `#predictions/<id>` (numeric segment) currently means "Markets tab with that
  row expanded". It now means "render `MarketDetailView` in `.predictions-main`,
  replacing the list".
- In `frontend-solid/src/pages/PredictionsPage.jsx`, `activeTab()` returns a new
  `detail` state when the param is numeric. The Markets tab button renders as
  active while in detail view.
- The back button navigates to `#predictions/markets`. Browser back/forward
  work because state is in the hash.
- Existing deep links to `#predictions/<id>` automatically get the new view.

## New component: `MarketDetailView.jsx`

Location: `frontend-solid/src/components/predictions/MarketDetailView.jsx`.
Receives `marketId` (string) and `onVerificationNotice`.

### Data

- `api.events.getById(id)` — title, `details`, `market_prob`, topics, category,
  `closing_date`, `outcome`, `event_type`.
- New API method `api.events.getTrades(eventId, limit)` calling the existing
  backend proxy `GET /api/events/:eventId/trades?limit=200`
  (`backend/src/routes/api.js:422` → engine `/events/:id/trades`). One fetch
  powers both the probability curve and the recent-activity feed. No backend
  changes required.

### Layout (top to bottom)

1. **← Back to markets** link → `#predictions/markets`.
2. **Header** — title, large current probability, probability bar, meta line
   (topics or category · closing date · Resolved tag when `outcome` is set).
3. **Description** — full `events.details` text. Omitted when empty.
4. **Probability curve** — hand-rolled inline SVG (no chart dependency):
   - Step-line of `price_after` over `created_at`, sorted ascending
     (endpoint returns DESC; reverse client-side).
   - Anchored at the earliest trade's `price_before`; extended horizontally to
     "now" at the current probability.
   - Y axis fixed 0–100%.
   - Binary events only. Multi-outcome events (`multiple_choice`, `numeric`)
     skip the chart — their trades are not in `market_updates`.
   - Fewer than 2 trades → chart hidden entirely.
5. **Trading card** — reuse existing components with `hideTitle`:
   `OutcomeMarketCard` when multi-outcome, else `MarketEventCard` (same
   `isMultiOutcome` switch as `EventsList` today). `onTrade` refetches event +
   trades so the header, curve, and activity feed all update.
6. **Recent activity** — the 15 most recent trades from the same response: user,
   direction (YES/NO), stake amount, price move (before → after), timestamp.
   Binary events only (same data limitation as the curve).

### States

- Loading: existing spinner pattern.
- Unknown/hidden/failed id: "Market not found" message plus the back link.
- Logged out: detail view fully visible; trading controls behave as the
  existing cards already do for anonymous users.

## Changes to `EventsList.jsx`

- Row click / Enter navigates: `window.location.hash = 'predictions/<id>'`.
  Rows keep `role="button"`, `tabindex`, and `activateOnKey`.
- Removed as obsolete:
  - `expandedIds` signal, `isExpanded`, accordion toggle in `handleEventClick`;
  - the `event-row-expanded` render block and its card imports (if unused
    elsewhere in the file);
  - the targeted-selection effect (deep-link fetch-and-expand) and
    `lastTargetedSelectionFetchKey` — deep links are handled by the route now;
  - the weekly auto-expand effect. The weekly question stays pinned first in
    the list with its tag; clicking it opens the detail view like any row.
- `targetedMarketId` prop from `PredictionsPage` is no longer passed or used.
- `aria-expanded` on rows is removed (nothing expands in place anymore).

## Styling

- CSS lives in `frontend-solid/src/styles.css` following existing naming:
  `.market-detail`, `.market-detail-header`, `.market-detail-chart`,
  `.market-detail-activity`, etc.
- Reuse existing tokens (`--border-color`, `--border-radius`, `--box-shadow`)
  and existing prob-bar styles where possible. Must look correct in dark mode
  and terminal skin like the rest of the predictions page.
- The fixed `height: 780px` on `.events-list-card` stays as-is for the list;
  the detail view is a normal flowing page section (no inner scroll box).

## Testing

Playwright spec (new file under `tests/e2e/`):

1. Markets tab → click a row → detail view shows title, trading card, back
   link; URL hash is `#predictions/<id>`.
2. Back link returns to the list (`#predictions/markets`).
3. Direct deep link to `#predictions/<id>` renders the detail view (also
   logged out: page visible, no crash).
4. Place a trade from the detail view → probability in the header updates
   (reuse the existing trade-test pattern and test users).
5. Unknown id (e.g. `#predictions/999999`) → "Market not found" + back link.

Run via the existing Playwright setup from the host; reset users with
`./tests/e2e/reset-test-users.sh` as usual.

## Out of scope

- Probability history for multi-outcome markets (needs engine work to expose
  outcome-level trade history).
- Any backend or prediction-engine changes.
- Comments/discussion on markets, position charts, or other new detail-page
  sections beyond those listed above.
