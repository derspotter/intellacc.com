const { test, expect } = require('@playwright/test');

// The markets list is server-paginated like the post feed: 100 rows per page,
// Load More appends, search and filters query the server. Guards against
// regressing to the render-all-2700-events behavior.

test.describe('predictions pagination', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#predictions');
    await page.waitForSelector('.events-simple-list li', { timeout: 20000 });
  });

  test('initial load is capped at one page', async ({ page }) => {
    const rows = await page.locator('.events-simple-list li').count();
    expect(rows).toBeLessThanOrEqual(101); // page + possibly pinned weekly
    await expect(page.locator('.events-summary p')).toContainText(/Showing \d+ of \d+ events/);
  });

  test('Load More appends the next page', async ({ page }) => {
    const before = await page.locator('.events-simple-list li').count();
    await page.getByRole('button', { name: 'Load More' }).click();
    await expect
      .poll(async () => page.locator('.events-simple-list li').count(), { timeout: 10000 })
      .toBeGreaterThan(before);
  });

  test('search filters server-side', async ({ page }) => {
    await page.locator('input[placeholder*="Search by title"]').fill('zzz-no-such-event-zzz');
    await expect(page.locator('.no-events')).toBeVisible({ timeout: 10000 });
  });
});
