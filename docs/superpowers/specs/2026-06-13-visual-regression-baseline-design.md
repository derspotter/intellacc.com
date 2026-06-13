# Visual-Regression Baseline (van skin) — Design

**Date:** 2026-06-13
**Status:** Approved design, pending implementation plan

## Goal

Stand up a Playwright visual-regression safety net for the key van-skin screens
so that CSS streamlining (and any future style change) produces a **red pixel
diff** when it unintentionally breaks a screen. This is the prerequisite
("step 1") before any CSS cleanup: the global stylesheet is ~10k lines with
broad element selectors (`button`, `input`, …) whose blast radius just caused
the topic-picker garble. Without screenshot coverage, refactors break things
silently.

## Scope decisions (made during brainstorming)

| Question | Decision |
|---|---|
| Determinism strategy | **B+A hybrid**: masked shells (B) for broad coverage + a couple of seeded real-render views (A) for the dynamic feed |
| Skins | **van skin only for v1**; terminal (Tailwind, low global-blast-radius) deferred |
| Run cadence | **Local, on-demand**; baselines committed to the repo. CI gate deferred |
| Tooling | Playwright `toHaveScreenshot()` (already a dependency) — no new deps |

## Architecture

- **One spec:** `tests/e2e/visual-regression.spec.js`, one `test()` per screen.
- **One helper:** `tests/e2e/helpers/visual.js` — fixed viewport, shared mask
  selector list, and a `gotoStable(page, hash, { token })` that navigates, waits
  for network idle / a stable marker, and lets `toHaveScreenshot` handle
  animation disabling.
- **Runs against** the source-mounted **solid-local** dev stack
  (`http://localhost:4174`, brought up with `docker compose -p solid-local -f
  docker-compose.solid-local.yml up -d`), so screenshots reflect the source
  being edited. Same target the other Solid specs use.
- **Auth/seed** reuses `tests/e2e/helpers/solidMessaging.js`
  (`createUser` incl. its registration-approval-token flow, token injection via
  `localStorage.setItem('token', …)`).
- **Baselines** stored by Playwright in
  `tests/e2e/visual-regression.spec.js-snapshots/` and committed. Playwright
  suffixes filenames per platform (e.g. `-chromium-linux.png`); v1 standardizes
  on generating/running in the same containerized dev environment (documented
  caveat).

## Anti-flake strategy (the make-or-break part)

- **Fixed viewport:** 1280×720 set in the helper for every screenshot.
- **Animation disabling:** rely on `toHaveScreenshot`'s default
  `animations: 'disabled'`.
- **AA tolerance:** small `maxDiffPixelRatio` (start at `0.01`) to absorb
  sub-pixel anti-aliasing noise without hiding real regressions.
- **Masks** (`toHaveScreenshot({ mask: [...] })`) for dynamic regions:
  - post timestamps / dates and relative times
  - like / comment counts
  - the Network page WebGL `<canvas>` (non-deterministic by nature)
  - any RP balance / reputation numbers rendered in chrome
- **Network idle wait** in `gotoStable` before snapshotting so async content has
  settled.

## Screens (~11 van-skin baselines)

**Masked shells (B) — no/empty data, broad layout coverage:**
1. Onboarding topic picker (token for a no-topics user → gate renders)
2. Home, logged-out (login notice + embedded search)
3. Login page
4. Sign-up page
5. Predictions page (chrome; market numbers masked)
6. Analytics page
7. Settings page
8. Network page (`<canvas>` masked)
9. Notifications page

**Seeded real-render (A) — catches regressions *inside* dynamic components:**
10. Home feed with a seeded fixture user + 2–3 fixed posts (timestamps & counts
    masked; post bodies, author row, action bar, layout visible). This is the
    one that guards `PostItem` / feed — the global-CSS blast zone.

(Optional 11th if cheap: a single market/prediction detail with numbers masked.)

## Workflow (documented in the spec header)

- **Generate baselines (first run / after intentional change):**
  `npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots`,
  then commit the new images.
- **Check before/after a CSS change:**
  `npx playwright test tests/e2e/visual-regression.spec.js` — a red pixel diff
  flags an unintended visual change; the diff image lands in
  `.playwright-test-results/`.
- **Caveat:** baselines are environment-specific (font anti-aliasing). They must
  be generated and run in the same containerized setup; cross-machine runs may
  show spurious diffs. This is why v1 is local-on-demand, not a CI gate.

## Out of scope (v1)

- Terminal skin baselines (Tailwind; add later if desired).
- CI integration / per-PR visual gating.
- Component-isolation harness (no Storybook; over-engineering for now).
- The CSS streamlining itself — this spec only builds the net that makes it safe.

## Success criteria

- `npx playwright test tests/e2e/visual-regression.spec.js` passes green on an
  unchanged tree, twice in a row (no flakiness), in the dev container.
- Deliberately editing a global rule (e.g. re-breaking `.topic-option`) makes
  the relevant baseline(s) fail with a visible diff — proving the net catches
  the class of bug it exists for.
- Test users created by the run are self-cleaned (honor `KEEP_E2E_USERS=1`).
