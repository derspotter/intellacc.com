// E2E: keyboard-only operation of the van skin. Shortcuts must work when not
// typing, never fire while typing, and everything interactive must be
// reachable and operable without a mouse.
const { test, expect } = require('@playwright/test');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

const login = async (page) => {
  await page.goto(`${BASE}/#login`);
  await page.getByLabel(/email/i).fill('user1@example.com');
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/#(home|feed)/, { timeout: 15000 });
};

test.describe('keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    // Land somewhere neutral with no focused input.
    await page.goto(`${BASE}/#home`);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
  });

  test('g p navigates to predictions, g h back home', async ({ page }) => {
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/#predictions$/);
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page).toHaveURL(/#home$/);
  });

  test('/ focuses the search input', async ({ page }) => {
    await page.keyboard.press('/');
    await expect(page).toHaveURL(/#search/);
    const active = page.locator('.search-input:focus');
    await expect(active).toHaveCount(1, { timeout: 5000 });
    await page.keyboard.type('hello');
    await expect(page.locator('.search-input')).toHaveValue('hello');
  });

  test('shortcuts do not fire while typing', async ({ page }) => {
    // The home page post composer is a textarea — typing g p there must not navigate.
    await page.locator('#solid-post-content').click();
    await page.keyboard.type('gp');
    await expect(page).toHaveURL(/#home$/);
  });

  test('? opens help overlay, Escape closes it', async ({ page }) => {
    await page.keyboard.press('?');
    const help = page.locator('.shortcut-help');
    await expect(help).toBeVisible();
    await expect(help).toContainText('g then p');
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
  });

  test('shortcuts are inert on the terminal skin', async ({ page }) => {
    // Terminal skin manages its own keys; the van registry must be unmounted.
    // The `?skin=` hash param (skinProvider.js) is the session-scoped skin
    // override: it takes effect immediately via the `hashchange` listener,
    // without touching localStorage or persisting to the account's saved
    // server preference (unlike the Settings-page skin toggle).
    await page.goto(`${BASE}/#home?skin=terminal`);
    await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal');
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).not.toHaveURL(/#predictions/);
  });
});

test.describe('keyboard row operation', () => {
  test('market row expands with Enter and collapses with Escape', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/markets`);
    await page.waitForSelector('.events-simple-list li');
    // Skip the weekly-assignment row: it auto-expands (and re-expands whenever
    // nothing else is open) independent of keyboard interaction, so it isn't
    // a stable target for asserting Enter/Escape toggle behavior.
    const targetLi = page.locator('.events-simple-list li:not(.weekly)').first();
    const firstRow = targetLi.locator('.event-list-item-row').first();
    await firstRow.focus();
    await page.keyboard.press('Enter');
    await expect(targetLi.locator('.event-row-expanded')).toBeVisible();
    await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(targetLi.locator('.event-row-expanded')).toHaveCount(0);
    // Focus stays on the row after collapsing.
    const stillFocused = await page.evaluate(() =>
      document.activeElement?.classList.contains('event-list-item-row')
    );
    expect(stillFocused).toBe(true);
  });

  test('post comment toggle is a focusable button', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#home`);
    await page.waitForSelector('.post-card', { timeout: 15000 });
    const toggle = page.locator('.post-card button.button-reset').first();
    await expect(toggle).toBeVisible();
  });
});

test.describe('list and pane navigation', () => {
  test('j/k move focus through feed posts', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#home`);
    await page.waitForSelector('.post-card', { timeout: 15000 });
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('j');
    const first = await page.evaluate(() => document.activeElement?.className);
    expect(first).toContain('post-card');
    await page.keyboard.press('j');
    const secondIsDifferent = await page.evaluate(
      () => document.activeElement === document.querySelectorAll('[data-kb-row]')[1]
    );
    expect(secondIsDifferent).toBe(true);
    await page.keyboard.press('k');
    const backToFirst = await page.evaluate(
      () => document.activeElement === document.querySelectorAll('[data-kb-row]')[0]
    );
    expect(backToFirst).toBe(true);
  });

  test('arrow keys jump between sidebar and market list', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/markets`);
    await page.waitForSelector('.events-simple-list li');
    // Click a market row itself (not the body at a fixed coordinate) — the
    // filters/search header above the list shifts height with content, so a
    // fixed (x, y) risks landing on the category-filter <select> instead.
    await page.locator('.event-list-item-row').first().click();
    await page.keyboard.press('ArrowLeft');
    const inSidebar = await page.evaluate(() =>
      document.activeElement?.closest('.sidebar') !== null
    );
    expect(inSidebar).toBe(true);
    await page.keyboard.press('ArrowDown');
    const stillInSidebar = await page.evaluate(() =>
      document.activeElement?.closest('.sidebar') !== null
    );
    expect(stillInSidebar).toBe(true);
    await page.keyboard.press('ArrowRight');
    const onRow = await page.evaluate(() =>
      document.activeElement?.hasAttribute('data-kb-row')
    );
    expect(onRow).toBe(true);
  });
});
