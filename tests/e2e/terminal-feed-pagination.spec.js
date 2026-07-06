// Terminal feed must cursor-paginate instead of loading every post.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, provisionTier, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('feed paginates with LOAD MORE', async ({ page }) => {
  test.setTimeout(60000);
  const u = await createUser('tfeed1');
  created.push(u);
  provisionTier(u);

  // Seed 25 posts (page size is 20) so page 2 exists regardless of DB state.
  // A small delay between requests avoids tripping a backend concurrency
  // ceiling (fire-and-forget per-post background work) that otherwise wedges
  // the server after ~10 back-to-back post creations for one user.
  for (let i = 0; i < 25; i++) {
    const { response } = await apiFetch('/api/posts', {
      method: 'POST',
      token: u.token,
      body: JSON.stringify({ content: `terminal feed pagination seed ${i}` })
    });
    if (response.status === 403) test.skip(true, 'posting requires verification tier; seed unavailable');
    expect([200, 201]).toContain(response.status);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  await expect(page.locator('[data-testid="feed-post"]').first()).toBeVisible({ timeout: 20000 });
  const before = await page.locator('[data-testid="feed-post"]').count();
  expect(before).toBeLessThanOrEqual(20);

  await page.locator('[data-testid="feed-load-more"]').click();
  await expect
    .poll(async () => page.locator('[data-testid="feed-post"]').count(), { timeout: 10000 })
    .toBeGreaterThan(before);
});
