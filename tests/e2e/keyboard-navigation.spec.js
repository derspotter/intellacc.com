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
