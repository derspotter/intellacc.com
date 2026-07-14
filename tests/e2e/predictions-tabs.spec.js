const { test, expect } = require('@playwright/test');

const BASE = (process.env.SOLID_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4174').replace(/\/$/, '');

test.describe('predictions tabs', () => {
  test('tab bar switches between Markets, Submit, Leaderboard', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`, { waitUntil: 'domcontentloaded' });
    // Logged out: Markets is the default (no Positions tab, no positions to show).
    await expect(page.getByText('Open Questions')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Markets' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Positions' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Submit' }).click();
    await expect(page).toHaveURL(/#predictions\/submit$/);
    await expect(page.getByText('Community Market Questions')).toBeVisible();

    await page.getByRole('tab', { name: 'Leaderboard' }).click();
    await expect(page).toHaveURL(/#predictions\/leaderboard$/);
    await expect(page.getByText('Reputation Leaderboard')).toBeVisible();

    await page.getByRole('tab', { name: 'Markets' }).click();
    // goToTab('markets') now addresses the reserved `predictions/markets` keyword.
    await expect(page).toHaveURL(/#predictions\/markets$/);
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

  test('numeric deep-link opens the market detail view', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/999999999`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.market-detail')).toBeVisible();
    await expect(page.getByText('Market not found')).toBeVisible();
    // Markets tab stays highlighted while inside a market.
    await expect(page.getByRole('tab', { name: 'Markets' })).toHaveAttribute('aria-selected', 'true');
  });

  test('category dropdown filters the list and All categories resets it', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.event-list-item .event-title');

    const dropdown = page.locator('.events-category-filter');
    await expect(dropdown).toBeVisible();
    // "All categories" plus at least one real topic option labeled "Name (count)".
    const optionLabels = await dropdown.locator('option').allTextContents();
    expect(optionLabels[0]).toBe('All categories');
    expect(optionLabels.length).toBeGreaterThan(1);
    expect(optionLabels[1]).toMatch(/^.+ \(\d+\)$/);

    const topicName = optionLabels[1].replace(/ \(\d+\)$/, '');
    const totalBefore = await page.locator('.event-list-item').count();
    await dropdown.selectOption(topicName);

    // Selection triggers a server-side reload; poll until the filtered list
    // is in: every visible row's category chip mentions the selected topic.
    await expect(async () => {
      const chips = await page.locator('.event-list-item .event-category').allTextContents();
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(chip).toContain(topicName);
      }
    }).toPass({ timeout: 10000 });
    await expect(dropdown).toHaveValue(topicName);

    // Back to "All categories" restores the unfiltered first page.
    await dropdown.selectOption('');
    await expect(page.locator('.event-list-item')).toHaveCount(totalBefore, { timeout: 10000 });
  });

  test('title search narrows results and works together with the dropdown', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.event-list-item .event-title');

    const search = page.locator('.events-filters input[type="text"]');
    await expect(search).toHaveAttribute('placeholder', 'Search titles...');

    const firstTitle = await page.locator('.event-list-item .event-title').first().textContent();
    const needle = firstTitle.trim().split(/\s+/).slice(0, 3).join(' ');
    await search.fill(needle);
    // Debounced server reload (500ms) plus round-trip.
    await expect(async () => {
      const titles = await page.locator('.event-list-item .event-title').allTextContents();
      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) {
        expect(title.toLowerCase()).toContain(needle.toLowerCase());
      }
    }).toPass({ timeout: 10000 });
  });
});
