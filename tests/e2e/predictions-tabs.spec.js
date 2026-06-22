const { test, expect } = require('@playwright/test');

const BASE = (process.env.SOLID_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4174').replace(/\/$/, '');

test.describe('predictions tabs', () => {
  test('tab bar switches between Markets, Submit, Leaderboard', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`, { waitUntil: 'domcontentloaded' });
    // Markets is the default: the events list header is visible.
    await expect(page.getByText('Open Questions')).toBeVisible();

    await page.getByRole('tab', { name: 'Submit' }).click();
    await expect(page).toHaveURL(/#predictions\/submit$/);
    await expect(page.getByText('Community Market Questions')).toBeVisible();

    await page.getByRole('tab', { name: 'Leaderboard' }).click();
    await expect(page).toHaveURL(/#predictions\/leaderboard$/);
    await expect(page.getByText('Reputation Leaderboard')).toBeVisible();

    await page.getByRole('tab', { name: 'Markets' }).click();
    await expect(page.getByText('Open Questions')).toBeVisible();
  });

  test('clicking a row expands forecasting inline; one open at a time', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`, { waitUntil: 'domcontentloaded' });
    const rows = page.locator('.event-list-item');
    await expect(rows.first()).toBeVisible();

    await rows.nth(1).locator('.event-list-item-row').click();
    await expect(rows.nth(1).locator('.event-row-expanded')).toBeVisible();

    // Accordion: opening another collapses the first.
    await rows.nth(2).locator('.event-list-item-row').click();
    await expect(rows.nth(2).locator('.event-row-expanded')).toBeVisible();
    await expect(rows.nth(1).locator('.event-row-expanded')).toHaveCount(0);
  });

  test('numeric deep-link stays on the Markets tab', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/999999999`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Open Questions')).toBeVisible();
  });
});
