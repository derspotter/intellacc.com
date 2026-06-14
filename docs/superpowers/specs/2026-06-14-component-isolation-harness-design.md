# Component-Isolation Visual-Regression Harness (v1) — Design

**Date:** 2026-06-14
**Status:** Approved design, pending implementation plan

## Goal

Give the visual-regression net deterministic coverage of the dynamic feed
component (`PostItem`) — the part of the UI where the global-CSS blast radius
concentrates and which the 7 page-level baselines can't cover, because the live
feed never reaches pixel-stability. Do it by rendering `PostItem` in **isolation
with fixed props**, so screenshots are stable.

## Why this approach

The existing net (`tests/e2e/visual-regression.spec.js`) covers 7 stable
page-level screens. The dynamic pages (feed, predictions, network) were tried
and dropped because they never stabilize for a pixel snapshot (live re-render,
WebGL animation, reflowing lists). `PostItem` is prop-driven on initial render
(`const post = () => props.post || {}`; its store/API calls fire only on
interaction), so feeding it a fixed `post` object yields a fixed render — the
clean way to cover it.

## Scope (v1)

- **In:** `PostItem` rendered in isolation, several fixture variants.
- **Out (deferred):** store/API-driven components (`MarketPanel`, `RPBalance`,
  the predictions header) — they fetch their own data on mount and would need a
  mock layer, which is its own maintenance burden and the part most likely to go
  flaky. A future iteration can add a mock layer if the gap still hurts.

## Architecture

### Dev-only harness route
- A hash route `#__harness` rendered **only when `import.meta.env.DEV`**.
  `solid-local` (where the net runs) uses `npm run dev` (Vite dev server →
  `DEV === true`); production uses `vite build`/`preview` (`DEV === false`), so
  the harness is **stripped from the prod bundle** — zero prod surface.
- Wiring: a small self-contained module `frontend-solid/src/_harness/Harness.jsx`
  imported into `VanApp.jsx` behind the `DEV` guard, and a `__harness` branch in
  the router's `renderPage`. When `DEV` is false the import/branch is dead code
  that the bundler drops.

### The gallery
- `Harness.jsx` renders a vertical list of `<PostItem post={fixture} />` for each
  fixture, wrapped in the normal `.posts-list` container so the surrounding feed
  CSS applies. No auth context required (logged-out render is deterministic — the
  edit/delete affordances that depend on the current user simply don't show).

### Fixtures (deterministic)
- Hardcoded `post` objects covering the fields `PostItem` reads: `id`,
  `user_id`, `username`, `content`, `created_at`, `like_count`, `comment_count`,
  `liked_by_user`, `avatar_url`, `image_url`/`image_attachment_id`,
  `reposted_post`, `ai_is_flagged`/`ai_probability`/`ai_detected_model`.
- **Fixed `created_at`** (e.g. `2026-01-01T00:00:00Z`) and fixed counts → the
  timestamp and like/comment text that made the live feed flaky are now
  constant. **No masking needed.**
- Variants:
  1. **basic** — short single-line content.
  2. **long** — multi-paragraph / very long content (wrapping, the picker-class
     risk).
  3. **repost** — populated `reposted_post` (nested author + content).
  4. **ai-flagged** — `ai_is_flagged: true` with probability/model.
  5. **high-counts** — large like/comment numbers.

## Net integration

- New screenshot tests (in `visual-regression.spec.js` or a sibling
  `visual-harness.spec.js`) that `goto` `#__harness`, wait for `.posts-list`, and
  `toHaveScreenshot` per the established pattern.
- Options: capture the whole gallery in one full-page screenshot (deterministic,
  one baseline) **or** one screenshot per variant via per-variant anchors. v1:
  **one full-gallery screenshot** (simplest; fixed content → stable). The plan
  can split into per-variant shots if the single image proves unwieldy.
- **No fixture user** needed (no `createUser`/topics/auth) — simpler and faster
  than the existing 7 tests.

## Workflow & safety

- Same workflow as the existing net: run `npx playwright test`; update baselines
  with `--update-snapshots=all`.
- **Prod-absence check** (in the plan): after a production `vite build`, grep the
  built bundle to confirm no `__harness` / fixture strings are present.
- Baselines remain environment-specific (font AA); generate/run in the
  containerized dev env, same caveat as the existing net.

## Success criteria

- `#__harness` renders the `PostItem` gallery on `solid-local`; the harness
  baseline(s) pass green across ≥3 consecutive runs (deterministic, no masking).
- A deliberate `PostItem`/feed CSS regression (e.g. break the post card layout)
  fails the harness baseline — proving it catches the class of bug the live feed
  couldn't.
- Production `vite build` contains no harness code (verified by grep).
