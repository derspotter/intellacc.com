// Uses a Vite fixture and mocked API; never creates users or trades in a real market.
const { test, expect } = require('@playwright/test');

for (const skin of ['van', 'terminal']) {
  test(`${skin}: save a daily policy, edit explicitly, restore, and pause`, async ({ page }) => {
    const writes = [];
    let rejectNextSave = false;
    let policy = { enabled: false, belief_prob: null, kelly_fraction: null, status: 'paused',
      check_interval_seconds: 86400, next_check_at: '2099-01-01T00:00:00Z' };
    await page.addInitScript(() => {
      localStorage.setItem('token', `e30.${btoa(JSON.stringify({ userId: 42, exp: 4102444800 }))}.test`);
    });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname.endsWith('/managed-position')) {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          writes.push(body);
          if (rejectNextSave) {
            rejectNextSave = false;
            await route.fulfill({ status: 503, json: { error: 'Manager temporarily unavailable' } });
            return;
          }
          policy = { ...policy, ...body, status: body.enabled ? 'scheduled' : 'paused' };
        }
        data = policy;
      } else if (url.pathname.endsWith('/kelly')) {
        data = { full_kelly: 125, balance: 1000, kelly_fraction: 0.25 };
      } else if (url.pathname.endsWith('/positions')) {
        data = [];
      } else if (url.pathname.includes('/verification/')) {
        data = { verification_tier: 2, phone_verified: true };
      } else if (url.pathname.endsWith('/update') || url.pathname.endsWith('/sell')) {
        throw new Error('Managing a position must not submit a manual trade');
      }
      await route.fulfill({ json: data });
    });
    const open = () => page.goto(`/test/managed-position.html?skin=${skin}`);
    await open();
    const control = page.getByTestId('managed-position-control');
    const toggle = control.getByRole('checkbox', { name: 'Automatically manage' });
    await expect(toggle).toBeEnabled();
    const belief = page.locator('.belief-probability-field input');
    await belief.fill('30');
    await belief.blur();
    await toggle.check();
    await expect(control).toContainText('Managing at 30.0%');
    expect(writes).toEqual([{ enabled: true, belief_prob: 0.3, kelly_fraction: 0.25 }]);
    await expect(control).toContainText('once a day');
    await page.evaluate(() => window.moveMarketPrice(0.5));
    await expect(belief).toHaveValue('30');
    expect(writes.length).toBe(1);
    await expect(page.getByRole('button', { name: /place (stake|trade)/i })).toBeDisabled();
    await belief.fill('40');
    await belief.blur();
    await page.getByRole('group', { name: 'Stake size as a fraction of Kelly' }).getByRole('button').nth(1).click();
    await expect(control.getByRole('button', { name: 'Save management settings' })).toBeVisible();
    expect(writes.length).toBe(1);
    await control.getByRole('button', { name: 'Save management settings' }).click();
    await expect(control).toContainText('Managing at 40.0%');
    await open();
    await expect(toggle).toBeChecked();
    await expect(belief).toHaveValue('40');
    await expect(page.getByRole('group', { name: 'Stake size as a fraction of Kelly' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    expect(writes.at(-1)).toEqual({ enabled: false });
    rejectNextSave = true;
    await toggle.check();
    await expect(control.getByRole('alert')).toContainText('Manager temporarily unavailable');
    await expect(toggle).not.toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.playwright-test-results/managed-position-${skin}.png`, fullPage: true });
  });
}
