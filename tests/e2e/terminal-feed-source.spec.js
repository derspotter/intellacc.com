// A fresh user follows nobody: their /feed is empty, so the terminal feed
// must fall back to discover mode (or, if discover is also empty, show the
// explicit empty state — never a blank pane).
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('fresh user gets discover fallback or explicit empty state', async ({ page }) => {
  const u = await createUser('tsrc1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  const banner = page.locator('[data-testid="feed-discover-banner"]');
  const empty = page.locator('[data-testid="feed-empty"]');
  const posts = page.locator('[data-testid="feed-post"]');
  await expect(banner.or(empty).or(posts.first())).toBeVisible({ timeout: 20000 });
  // If discover mode is active, posts must carry FOLLOW buttons.
  if (await banner.isVisible()) {
    await expect(page.locator('[data-testid="discover-follow"]').first()).toBeVisible();
  }
});
