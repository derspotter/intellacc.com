// Market pane must be server-paginated (100/page) and server-searchable —
// guards against regressing to render-all-5000-events.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

// NOTE: MarketPanel.jsx currently renders two copies of the market list/detail
// tree (a `md:hidden` mobile branch and a `hidden md:flex` desktop branch) —
// both exist in the DOM at all times, CSS just hides one per viewport. A
// later task merges the duplication. Until then, every testid below is
// duplicated, so we scope locators to `:visible` to target only the branch
// that's actually rendered at the default (desktop) test viewport.
async function openMarketPane(page, prefix) {
  const u = await createUser(prefix);
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#predictions`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  await expect(page.locator('[data-testid="market-row"]:visible').first()).toBeVisible({ timeout: 20000 });
}

test('initial market list is capped at one page', async ({ page }) => {
  await openMarketPane(page, 'tmkt1');
  const rows = await page.locator('[data-testid="market-row"]:visible').count();
  expect(rows).toBeLessThanOrEqual(100);
  await expect(page.locator('[data-testid="market-count"]:visible')).toContainText(/\d+\/\d+/);
});

test('LOAD MORE appends the next page', async ({ page }) => {
  await openMarketPane(page, 'tmkt2');
  const before = await page.locator('[data-testid="market-row"]:visible').count();
  await page.locator('[data-testid="market-load-more"]:visible').click();
  await expect
    .poll(async () => page.locator('[data-testid="market-row"]:visible').count(), { timeout: 10000 })
    .toBeGreaterThan(before);
});

test('search queries the server', async ({ page }) => {
  await openMarketPane(page, 'tmkt3');
  await page.locator('[data-testid="market-search"]:visible').fill('zzz-no-such-event-zzz');
  await expect(page.locator('[data-testid="market-empty"]:visible')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-testid="market-count"]:visible')).toContainText('0/');
});
