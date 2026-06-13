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
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, provisionTier, cleanupUsers } = require('./helpers/solidMessaging');
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

  // Seeded feed: onboardedUser follows posterUser, who authors fixed posts, so
  // onboardedUser's following-feed renders those exact posts deterministically.
  const posterUser = await createUser('visualposter');
  created.push(posterUser);
  // Posting requires verification tier 1 (email); fresh users start at tier 0,
  // so the create-post API 403s without this. Without real posts the
  // following-feed is empty and the home page falls back to discover (dynamic).
  provisionTier(posterUser);
  for (const content of [
    'Visual baseline post one: markets are a discovery mechanism.',
    'Visual baseline post two: calibration beats confidence.',
    'Visual baseline post three: forecasting is a skill you can train.'
  ]) {
    await apiFetch('/api/posts', {
      method: 'POST',
      token: posterUser.token,
      body: JSON.stringify({ content })
    });
  }
  await apiFetch(`/api/users/${posterUser.id}/follow`, {
    method: 'POST',
    token: onboardedUser.token
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

// Per-page masks for dynamic regions that the global mask list doesn't cover.
// predictions shows the GLOBAL open-markets list (drifts with imports/trades);
// network shows a live "N users · M follows" count. analytics/notifications are
// user-specific and deterministically empty for the fresh fixture user.
const EXTRA_MASKS = {
  predictions: ['.events-list-card'],
  network: ['.network-stats']
};

for (const [hash, name] of [
  ['predictions', 'predictions'],
  ['analytics', 'analytics'],
  ['settings', 'settings'],
  ['network', 'network'],
  ['notifications', 'notifications']
]) {
  test(`${name} page`, async ({ page }) => {
    await gotoStable(page, hash, { token: onboardedUser.token });
    const extra = (EXTRA_MASKS[name] || []).map((sel) => page.locator(sel));
    await expect(page).toHaveScreenshot(`${name}.png`, { mask: [...masks(page), ...extra] });
  });
}

test('home feed (seeded)', async ({ page }) => {
  await gotoStable(page, 'home', { token: onboardedUser.token });
  await expect(page.locator('.posts-list')).toBeVisible({ timeout: 15000 });
  // Confirm the seeded posts actually rendered (rules out an empty/discover feed)
  // before snapshotting, so the baseline is deterministic.
  await expect(page.getByText('Visual baseline post one', { exact: false })).toBeVisible({ timeout: 15000 });
  // The poster's username is randomly generated per run (createUser), so mask it
  // too — otherwise the baseline drifts. The fixed post bodies stay visible.
  await expect(page).toHaveScreenshot('home-feed-seeded.png', {
    mask: [...masks(page), page.locator('.username-link')]
  });
});
