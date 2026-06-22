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

  test('clicking a market expands forecasting inline in place (no movement)', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.event-list-item .event-title');
    const rows = page.locator('.event-list-item');

    // Document-relative top of row 3's title (scroll-independent), via native
    // clicks that don't auto-scroll, mirroring real user interaction.
    const docTop = () => page.evaluate(() => {
      const t = document.querySelectorAll('.event-list-item')[3].querySelector('.event-title');
      return Math.round(t.getBoundingClientRect().top + window.scrollY);
    });

    const before = await docTop();
    await page.$$eval('.event-list-item .event-list-item-row', (els) => els[3].click());
    await expect(rows.nth(3).locator('.event-row-expanded')).toBeVisible();
    const after = await docTop();
    // The clicked market must not move in the document when it expands.
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);

    // Opening another market does not collapse the first (independent toggles).
    await page.$$eval('.event-list-item .event-list-item-row', (els) => els[1].click());
    await expect(rows.nth(1).locator('.event-row-expanded')).toBeVisible();
    await expect(rows.nth(3).locator('.event-row-expanded')).toBeVisible();
  });

  test('numeric deep-link stays on the Markets tab', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/999999999`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Open Questions')).toBeVisible();
  });
});
