# Visual-Regression Baseline (van skin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A committed set of Playwright screenshot baselines for the key van-skin screens, so CSS changes that break a screen produce a red pixel diff.

**Architecture:** One spec (`tests/e2e/visual-regression.spec.js`) with one `test()` per screen, a small helper (`tests/e2e/helpers/visual.js`) for viewport + masks + stable navigation, run from the host against the source-mounted solid-local dev stack (`http://localhost:4174`). Baselines live in `tests/e2e/visual-regression.spec.js-snapshots/` and are committed.

**Tech Stack:** Playwright `toHaveScreenshot()` (already a dependency), existing `tests/e2e/helpers/solidMessaging.js` for user creation/auth.

**Spec:** `docs/superpowers/specs/2026-06-13-visual-regression-baseline-design.md`

**Conventions (read before starting):**
- The dev stack MUST be up first, ALWAYS with `-p solid-local`:
  `docker compose -p solid-local -f docker-compose.solid-local.yml up -d`
  Confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/` → `200`.
  Leave it up for the whole plan; the prod container (`intellacc_frontend_solid`) is separate.
- Run tests from the repo root on the host: `npx playwright test tests/e2e/visual-regression.spec.js`
- Playwright screenshot lifecycle: the FIRST run with a new `toHaveScreenshot('x.png')` and no baseline **fails** ("A snapshot doesn't exist … writing actual"). Re-run with `--update-snapshots` to write the baseline, then a normal run passes. That is this plan's red→green.
- After generating each baseline, **open the PNG and eyeball it** (it's a real screenshot — confirm the screen rendered correctly and the masks cover the dynamic bits) before committing.
- `solidMessaging.js` exports (all used below): `SOLID_URL` (defaults `http://127.0.0.1:4174`), `createUser(label)` (registers, auto-approves via `registration_approval_tokens`, logs in, returns `{ id, username, email, password, token }`), `apiFetch(path, { method, body, token })`, `cleanupUsers(users)` (honors `KEEP_E2E_USERS=1`).

---

### Task 1: Visual helper + config + first baseline (logged-out home)

**Files:**
- Create: `tests/e2e/helpers/visual.js`
- Create: `tests/e2e/visual-regression.spec.js`
- Modify: `playwright.config.js`

- [ ] **Step 1: Add a screenshot tolerance to `playwright.config.js`**

The repo config currently has no `expect` block. Add one so anti-aliasing noise doesn't cause false diffs. Full updated file:

```js
// Playwright config for this repo.
// Keeps all Playwright artifacts in a writable directory (avoids root-owned `test-results`).
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  outputDir: '.playwright-test-results',
  workers: 1,
  reporter: [['line']],
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01
    }
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure'
  }
});
```

- [ ] **Step 2: Create the helper `tests/e2e/helpers/visual.js`**

```js
// Helpers for visual-regression screenshots: fixed viewport, mask list for
// dynamic regions, and stable navigation that settles the page before snapshot.
const { SOLID_URL } = require('./solidMessaging');

const VIEWPORT = { width: 1280, height: 720 };

// Locators for regions whose pixels legitimately change between runs. Mask
// matches zero elements harmlessly on screens where a selector is absent.
const masks = (page) => [
  page.locator('.post-date'),
  page.locator('.post-header-likes'),
  page.locator('.post-header-comments'),
  page.locator('.user-stats-horizontal'),
  page.locator('canvas') // Network page WebGL graph
];

// Navigate to a hash route with a stable, screenshot-ready page. If `token` is
// given, it is injected into localStorage before any app script runs.
async function gotoStable(page, hash, { token } = {}) {
  await page.setViewportSize(VIEWPORT);
  if (token) {
    await page.addInitScript((t) => localStorage.setItem('token', t), token);
  }
  await page.goto(`${SOLID_URL}/#${hash}`, { waitUntil: 'networkidle' });
  // Let fonts/layout settle; toHaveScreenshot also disables animations.
  await page.waitForTimeout(500);
}

module.exports = { VIEWPORT, masks, gotoStable };
```

- [ ] **Step 3: Create the spec with fixtures + the first (logged-out home) test**

```js
// Visual-regression baselines for the van skin. See
// docs/superpowers/specs/2026-06-13-visual-regression-baseline-design.md
//
// Run (dev stack must be up: docker compose -p solid-local -f docker-compose.solid-local.yml up -d):
//   npx playwright test tests/e2e/visual-regression.spec.js
// Generate / update baselines after an intentional visual change:
//   npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots
// Keep test users for debugging: KEEP_E2E_USERS=1
//
// Baselines are environment-specific (font anti-aliasing): generate & run them
// in the same containerized dev environment.
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers } = require('./helpers/solidMessaging');
const { masks, gotoStable } = require('./helpers/visual');

const created = [];

test.afterAll(async () => {
  cleanupUsers(created);
});

test('home logged-out', async ({ page }) => {
  await gotoStable(page, 'home');
  await expect(page).toHaveScreenshot('home-logged-out.png', { mask: masks(page), fullPage: true });
});
```

- [ ] **Step 4: Bring up the dev stack and run the test (expect baseline-missing failure)**

Run:
```bash
docker compose -p solid-local -f docker-compose.solid-local.yml up -d
until curl -sf -o /dev/null http://localhost:4174/; do sleep 2; done
npx playwright test tests/e2e/visual-regression.spec.js
```
Expected: FAIL — "A snapshot doesn't exist at …home-logged-out…, writing actual."

- [ ] **Step 5: Generate the baseline, eyeball it, re-run green**

Run:
```bash
npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots
```
Then open `tests/e2e/visual-regression.spec.js-snapshots/home-logged-out-chromium-linux.png` (filename suffix may differ by platform) and confirm it shows the logged-out home (sidebar, "Sign in to create posts", search). Re-run without the flag:
```bash
npx playwright test tests/e2e/visual-regression.spec.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.js tests/e2e/helpers/visual.js tests/e2e/visual-regression.spec.js tests/e2e/visual-regression.spec.js-snapshots/
git commit -m "test(visual): harness + logged-out home baseline"
```

---

### Task 2: Logged-out auth pages (login, signup)

**Files:**
- Modify: `tests/e2e/visual-regression.spec.js`

- [ ] **Step 1: Add the login and signup tests**

Append after the `home logged-out` test:

```js
test('login page', async ({ page }) => {
  await gotoStable(page, 'login');
  await expect(page).toHaveScreenshot('login.png', { mask: masks(page), fullPage: true });
});

test('signup page', async ({ page }) => {
  await gotoStable(page, 'signup');
  await expect(page).toHaveScreenshot('signup.png', { mask: masks(page), fullPage: true });
});
```

- [ ] **Step 2: Run (expect baseline-missing failures for the two new shots)**

Run: `npx playwright test tests/e2e/visual-regression.spec.js`
Expected: FAIL on `login.png` and `signup.png` (missing baselines); `home-logged-out` still passes.

- [ ] **Step 3: Generate baselines, eyeball, re-run green**

Run: `npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots`
Open the two new PNGs in the snapshots dir — confirm the login form and signup form render. Re-run:
`npx playwright test tests/e2e/visual-regression.spec.js`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/visual-regression.spec.js tests/e2e/visual-regression.spec.js-snapshots/
git commit -m "test(visual): login + signup baselines"
```

---

### Task 3: Onboarding gate (no-topics user) baseline

**Files:**
- Modify: `tests/e2e/visual-regression.spec.js`

**Context:** A logged-in user with zero `user_topics` rows is forced to the `TopicPicker` on every non-auth route. `createUser` returns a logged-in user with no topics, so its token alone triggers the gate.

- [ ] **Step 1: Add a no-topics fixture and the picker test**

Add near the top (after `const created = [];`):

```js
let noTopicsUser;

test.beforeAll(async () => {
  noTopicsUser = await createUser('visualgate');
  created.push(noTopicsUser);
});
```

Add the test:

```js
test('onboarding topic picker', async ({ page }) => {
  await gotoStable(page, 'home', { token: noTopicsUser.token });
  // Gate renders the picker instead of page content.
  await expect(page.locator('.topic-picker')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveScreenshot('onboarding-topic-picker.png', { mask: masks(page), fullPage: true });
});
```

- [ ] **Step 2: Run (expect baseline-missing failure for the picker)**

Run: `npx playwright test tests/e2e/visual-regression.spec.js`
Expected: FAIL on `onboarding-topic-picker.png` (missing baseline); the `.topic-picker` visibility assertion should PASS first (proving the gate rendered).

- [ ] **Step 3: Generate baseline, eyeball, re-run green**

Run: `npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots`
Open `onboarding-topic-picker.png` — confirm the picker grid renders cleanly (cards with names + wrapped descriptions, no overflow — this is the screen whose regression we are guarding). Re-run:
`npx playwright test tests/e2e/visual-regression.spec.js`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/visual-regression.spec.js tests/e2e/visual-regression.spec.js-snapshots/
git commit -m "test(visual): onboarding topic picker baseline"
```

---

### Task 4: Authed page shells (predictions, analytics, settings, network, notifications)

**Files:**
- Modify: `tests/e2e/visual-regression.spec.js`

**Context:** These pages require auth AND the user to be past the onboarding gate, so the fixture needs ≥3 topics. The topics API is `GET /api/topics` (public list) and `PUT /api/users/me/topics` (`{ topicIds }`, requires ≥3).

- [ ] **Step 1: Add a with-topics fixture**

Extend `beforeAll` to also create a user that has completed onboarding:

```js
let noTopicsUser;
let onboardedUser;

test.beforeAll(async () => {
  noTopicsUser = await createUser('visualgate');
  created.push(noTopicsUser);

  onboardedUser = await createUser('visualfeed');
  created.push(onboardedUser);
  const topics = (await apiFetch('/api/topics')).body.topics;
  const topicIds = topics.slice(0, 3).map((t) => t.id);
  await apiFetch('/api/users/me/topics', {
    method: 'PUT',
    token: onboardedUser.token,
    body: JSON.stringify({ topicIds })
  });
});
```

(Replace the existing `beforeAll`/`noTopicsUser` declarations from Task 3 with this expanded version.)

- [ ] **Step 2: Add the five authed-shell tests**

```js
for (const [hash, name] of [
  ['predictions', 'predictions'],
  ['analytics', 'analytics'],
  ['settings', 'settings'],
  ['network', 'network'],
  ['notifications', 'notifications']
]) {
  test(`${name} page`, async ({ page }) => {
    await gotoStable(page, hash, { token: onboardedUser.token });
    await expect(page).toHaveScreenshot(`${name}.png`, { mask: masks(page), fullPage: true });
  });
}
```

- [ ] **Step 3: Run (expect baseline-missing failures for the five)**

Run: `npx playwright test tests/e2e/visual-regression.spec.js`
Expected: FAIL on the 5 new snapshots; earlier 4 still pass.

- [ ] **Step 4: Generate baselines, eyeball each, re-run green**

Run: `npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots`
Open all 5 PNGs. Confirm each page rendered (not an error/blank), and that on `network.png` the WebGL canvas area is masked (solid block) rather than showing a random graph. If `network.png` still shows non-canvas dynamic noise, note it. Re-run:
`npx playwright test tests/e2e/visual-regression.spec.js`
Expected: PASS (9 tests). If `network` flakes across two runs, the graph isn't fully masked — widen the mask to the canvas's container element and regenerate.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/visual-regression.spec.js tests/e2e/visual-regression.spec.js-snapshots/
git commit -m "test(visual): predictions/analytics/settings/network/notifications baselines"
```

---

### Task 5: Seeded home feed (real-render) baseline

**Files:**
- Modify: `tests/e2e/visual-regression.spec.js`

**Context:** This is the "A" view — it renders real `PostItem`s so a regression *inside* the feed component is caught. The `onboardedUser` authors fixed posts so content is deterministic; timestamps/counts are masked. Post creation is `POST /api/posts` with `{ content }`.

- [ ] **Step 1: Seed fixed posts in `beforeAll`**

Append to the `beforeAll` (after setting `onboardedUser`'s topics):

```js
  // Deterministic feed content for the seeded screenshot.
  for (const content of [
    'Visual baseline post one: markets are a discovery mechanism.',
    'Visual baseline post two: calibration beats confidence.',
    'Visual baseline post three: forecasting is a skill you can train.'
  ]) {
    await apiFetch('/api/posts', {
      method: 'POST',
      token: onboardedUser.token,
      body: JSON.stringify({ content })
    });
  }
```

- [ ] **Step 2: Add the seeded-feed test**

```js
test('home feed (seeded)', async ({ page }) => {
  await gotoStable(page, 'home', { token: onboardedUser.token });
  // The onboarded user follows nobody; their own posts appear in the feed.
  await expect(page.locator('.posts-list')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveScreenshot('home-feed-seeded.png', { mask: masks(page), fullPage: true });
});
```

- [ ] **Step 3: Run (expect baseline-missing failure)**

Run: `npx playwright test tests/e2e/visual-regression.spec.js`
Expected: FAIL on `home-feed-seeded.png`.

NOTE: if the onboarded user's own posts do not appear in their home feed (the feed may be following-only and fall back to the discover feed), the seeded posts still belong to that user — verify the screenshot shows the three baseline posts. If the feed shows discover content instead, switch the test to assert on `.posts-list` presence only and accept whatever deterministic posts render, OR have the user self-follow is not possible — instead confirm the three posts render via their visible text before snapshotting:
```js
await expect(page.getByText('Visual baseline post one', { exact: false })).toBeVisible();
```
Add that assertion before the screenshot if needed.

- [ ] **Step 4: Generate baseline, eyeball, re-run green twice**

Run: `npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots`
Open `home-feed-seeded.png` — confirm the 3 posts render with author row + action bar, and that `.post-date`/`.post-header-likes`/`.post-header-comments` are masked (solid blocks). Re-run twice:
```bash
npx playwright test tests/e2e/visual-regression.spec.js
npx playwright test tests/e2e/visual-regression.spec.js
```
Expected: PASS both times (10 tests), proving the seeded view is stable.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/visual-regression.spec.js tests/e2e/visual-regression.spec.js-snapshots/
git commit -m "test(visual): seeded home feed baseline"
```

---

### Task 6: Prove the net catches regressions, document, finalize

**Files:**
- Modify: `tests/e2e/visual-regression.spec.js` (header doc only, if needed)
- Modify: `docs/feature-roadmap.md`

- [ ] **Step 1: Verify the suite is green and non-flaky**

Run twice:
```bash
npx playwright test tests/e2e/visual-regression.spec.js
npx playwright test tests/e2e/visual-regression.spec.js
```
Expected: PASS both runs (10 tests), no diffs.

- [ ] **Step 2: Prove it catches a real regression (temporary break)**

Temporarily re-break the topic picker to confirm the net fires. Edit `frontend-solid/src/styles.css`: in the `.topic-option` rule, change `white-space: normal;` to `white-space: nowrap;`. Then:
```bash
npx playwright test tests/e2e/visual-regression.spec.js --grep "topic picker"
```
Expected: FAIL on `onboarding-topic-picker.png` with a pixel diff (diff image in `.playwright-test-results/`). This proves the guard works.

- [ ] **Step 3: Revert the temporary break**

```bash
git checkout frontend-solid/src/styles.css
npx playwright test tests/e2e/visual-regression.spec.js --grep "topic picker"
```
Expected: PASS again (no source change committed).

- [ ] **Step 4: Confirm test users are cleaned up**

Run:
```bash
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -t -c "SELECT count(*) FROM users WHERE username LIKE 'sm_visual%';"
```
Expected: `0` (the `afterAll` `cleanupUsers` removed them). If non-zero, the run was interrupted; delete manually:
`docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "DELETE FROM users WHERE username LIKE 'sm_visual%';"`

- [ ] **Step 5: Add a roadmap note and commit**

Add under "Later (unordered)" in `docs/feature-roadmap.md`:

```markdown
- **Visual-regression net (v1 shipped 2026-06-13)**: ~10 van-skin Playwright
  screenshot baselines (`tests/e2e/visual-regression.spec.js`), local on-demand,
  as the safety net for CSS streamlining. Follow-ups: terminal-skin baselines and
  CI integration once baselines prove stable across the containerized env.
```

```bash
git add docs/feature-roadmap.md
git commit -m "docs(roadmap): note visual-regression net v1"
```

---

## Self-review notes

- **Spec coverage:** B+A hybrid → masked shells (Tasks 1–4) + seeded feed (Task 5); van-only → all routes are van-skin; ~11 baselines → 10 (`home-logged-out`, `login`, `signup`, `onboarding-topic-picker`, `predictions`, `analytics`, `settings`, `network`, `notifications`, `home-feed-seeded`); anti-flake → config `maxDiffPixelRatio`, `VIEWPORT`, `masks`; local on-demand + committed baselines → run commands + committed `-snapshots/`; success criteria → Task 6 (green ×2, regression caught, users cleaned).
- **Selectors verified against source:** `.post-date`, `.post-header-likes`, `.post-header-comments` (PostItem.jsx), `.user-stats-horizontal` (RPBalance.jsx), `.topic-picker`/`.topic-option` (TopicPicker.jsx), `.posts-list` (PostsList.jsx), `canvas` (network).
- **Helper API consistent across tasks:** `gotoStable(page, hash, { token })` and `masks(page)` used identically everywhere; fixtures `noTopicsUser`/`onboardedUser` defined once in `beforeAll`.
- **Known adaptation point (flagged in Task 5):** whether the onboarded user's own posts surface in their home feed vs discover fallback — the task includes the text-assertion fallback to keep the seeded shot deterministic.
