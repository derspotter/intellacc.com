// A fresh user follows nobody. The blended feed must still render: posts tied
// to markets in their topics, posts by users sharing their topics, or — while
// those are thin — the global fall-through. Only a truly empty database gives
// the explicit empty state; never a blank pane.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('fresh user gets blended feed posts or an explicit empty state', async ({ page }) => {
  const u = await createUser('tsrc1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  const empty = page.locator('[data-testid="feed-empty"]');
  const posts = page.locator('[data-testid="feed-post"]');
  await expect(empty.or(posts.first())).toBeVisible({ timeout: 20000 });

  // Any post a fresh user sees came from a blended source, never a follow, so
  // it must explain itself and offer a one-click follow.
  if (await posts.first().isVisible()) {
    await expect(page.locator('[data-testid="discover-follow"]').first()).toBeVisible();
  }
});
