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
  // Gate renders the picker instead of page content.
  await expect(page.locator('.topic-picker')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveScreenshot('onboarding-topic-picker.png', { mask: masks(page), fullPage: true });
});

for (const [hash, name] of [
  ['predictions', 'predictions'],
  ['analytics', 'analytics'],
  ['settings', 'settings'],
  ['network', 'network'],
  ['notifications', 'notifications']
]) {
  test(`${name} page`, async ({ page }) => {
    await gotoStable(page, hash, { token: onboardedUser.token });
    await expect(page).toHaveScreenshot(`${name}.png`, { mask: masks(page) });
  });
}
