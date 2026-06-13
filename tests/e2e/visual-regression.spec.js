// Visual-regression baselines for the van skin. See
// docs/superpowers/specs/2026-06-13-visual-regression-baseline-design.md
//
// Run (dev stack must be up: docker compose -p solid-local -f docker-compose.solid-local.yml up -d):
//   npx playwright test tests/e2e/visual-regression.spec.js
// Generate / update baselines after an intentional visual change:
//   npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots=all
// NOTE: use --update-snapshots=all (not plain --update-snapshots): the plain form
// skips rewriting a baseline when the new screenshot still matches within
// maxDiffPixelRatio (0.01), which silently leaves stale baselines on disk.
// Keep test users for debugging: KEEP_E2E_USERS=1
//
// Baselines are environment-specific (font anti-aliasing): generate & run them
// in the same containerized dev environment.
//
// SCOPE (v1): only screens that reach visual STABILITY are baselined. Three live
// views were tried and deliberately excluded because they never stabilize for a
// pixel snapshot (Playwright re-screenshots until two consecutive frames match):
//   - network    — the 3D WebGL force graph animates continuously
//   - predictions — the global open-markets list updates / reflows
//   - home feed   — live feed re-renders; deterministic only via component isolation
// Covering those needs a component-isolation harness (render PostItem/MarketPanel
// with fixed props on a static route) — deferred. See the design doc.
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers } = require('./helpers/solidMessaging');
const { masks, gotoStable } = require('./helpers/visual');

const created = [];

let noTopicsUser;
let onboardedUser;

test.beforeAll(async () => {
  // A user with no topics → forced to the onboarding gate (for the picker shot).
  noTopicsUser = await createUser('visualgate');
  created.push(noTopicsUser);

  // A user past the gate (≥3 topics) → can reach authed pages. Fresh account, so
  // its analytics/settings/notifications render in deterministic empty states.
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

test.afterAll(async () => {
  cleanupUsers(created);
});

test('home logged-out', async ({ page }) => {
  await gotoStable(page, 'home');
  // Viewport-only + feed masked: the logged-out home renders the live public
  // feed (dynamic). We only want the stable chrome — nav, login notice, search
  // bar, tabs. fullPage + an unmasked feed would break on any new post.
  await expect(page).toHaveScreenshot('home-logged-out.png', {
    mask: [...masks(page), page.locator('.posts-list')]
  });
});

test('login page', async ({ page }) => {
  await gotoStable(page, 'login');
  await expect(page).toHaveScreenshot('login.png', { mask: masks(page) });
});

test('signup page', async ({ page }) => {
  await gotoStable(page, 'signup');
  await expect(page).toHaveScreenshot('signup.png', { mask: masks(page) });
});

test('onboarding topic picker', async ({ page }) => {
  await gotoStable(page, 'home', { token: noTopicsUser.token });
  // Gate renders the picker instead of page content. Deterministic (fixed 10
  // seeded topics), so fullPage captures the whole grid — the screen whose
  // global-button-rule garble this net exists to catch.
  await expect(page.locator('.topic-picker')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveScreenshot('onboarding-topic-picker.png', { mask: masks(page), fullPage: true });
});

// Authed pages that render in deterministic states for a fresh onboarded user:
// analytics (all-zero stats), settings (static), notifications (empty).
for (const [hash, name] of [
  ['analytics', 'analytics'],
  ['settings', 'settings'],
  ['notifications', 'notifications']
]) {
  test(`${name} page`, async ({ page }) => {
    await gotoStable(page, hash, { token: onboardedUser.token });
    await expect(page).toHaveScreenshot(`${name}.png`, { mask: masks(page) });
  });
}
