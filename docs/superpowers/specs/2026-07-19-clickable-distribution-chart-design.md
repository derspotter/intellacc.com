# Clickable distribution chart — design

Date: 2026-07-19
Status: approved (chat)

## Goal

Let traders set their Low/Center/High (P10/P50/P90) values directly on the
numeric-market SVG chart by clicking and dragging, instead of only through the
three number inputs below it.

## Interaction model (approved)

Click + drag, all three handles:

- `pointerdown` anywhere on the chart plot picks the **nearest** of the three
  guide lines (by on-screen pixel distance) and moves it to that x-position.
- With `setPointerCapture`, subsequent `pointermove` keeps dragging that same
  handle; `pointerup` releases. A plain click is a zero-length drag — same code
  path.
- Clicks in the tail gutters (open-tail markets) clamp to range min/max; the
  P10/P50/P90 handles cannot live inside a tail bucket.
- Disabled while `busyAction()` is set (mirrors the inputs' `disabled`) and
  when the market is closed.

## Implementation shape

One pointer-event layer on the existing SVG in
`frontend-solid/src/components/predictions/DistributionMarketCard.jsx` —
not per-handle hit rectangles (fiddly when lines overlap at small spreads) and
not an HTML range-slider overlay (fights the log transform and tail-gutter
layout).

1. **Coordinate mapping.** Pointer clientX → viewBox x via
   `getBoundingClientRect()` scaled to `CHART_W` (the SVG uses
   `preserveAspectRatio="none"`, so the map is linear). ViewBox x → t via the
   inverse of `toX` (plotLeft/plotRight aware), then t → nominal via the
   existing `transform().toNominal(t)`. Log-scaled markets follow the log axis
   for free.
2. **Routing.** The drag calls the existing `updateLow/updateCenter/updateHigh`,
   so low ≤ center ≤ high clamping, the debounced quote, and number-input sync
   are unchanged.
3. **Affordances.** Grab circles at the top of each guide line,
   `cursor: grab`/`grabbing`, `touch-action: none` on the SVG so phone drags
   don't scroll the page. Styles join the existing `distribution-card-*`
   classes in `frontend-solid/src/styles.css`.
4. **Fallbacks unchanged.** Number inputs and Narrow/Medium/Wide presets stay;
   keyboard/a11y path remains the inputs.

## Testing

- Unit tests for the x→t→nominal inversion (linear + log configs, tail-gutter
  offsets) — pure helper in `distributionMath.js`
  (`frontend-solid/src/utils/distributionMath.test.js`).
- Playwright: on a numeric market, click the chart near the center guide and
  assert the Center (P50) input updates; drag and assert continuous update
  (extend the existing numeric-market E2E spec).
