const { test, expect } = require('@playwright/test');

const USER = { email: 'user1@example.com', password: 'password123' };

async function resetServerState() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('./tests/e2e/reset-test-users.sh', (error, stdout, stderr) => {
      if (error) {
        console.warn('Reset script warning:', stderr);
      }
      console.log('Server state reset:', stdout.includes('Reset complete'));
      resolve();
    });
  });
}

async function clearBrowserStorage(page) {
  await page.goto('/#login');
  await page.waitForTimeout(500);

  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();

    const databases = await indexedDB.databases();
    const deletePromises = databases.map(db => new Promise((resolve) => {
      if (!db.name) return resolve();
      const req = indexedDB.deleteDatabase(db.name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    }));

    await Promise.all(deletePromises);
  });

  await page.waitForTimeout(500);
}

async function loginAsFirstDevice(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.locator('#password')).toBeVisible({ timeout: 15000 });
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.locator('.home-page')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(3000);
}

test.describe('Staged Login Flow', () => {
  test.beforeEach(async () => {
    await resetServerState();
  });

  test('requires approval before password entry on a new device', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await clearBrowserStorage(pageA);
    await loginAsFirstDevice(pageA, USER);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await clearBrowserStorage(pageB);

    await pageB.goto('/#login');
    await pageB.fill('#email', USER.email);
    await pageB.getByRole('button', { name: 'Continue' }).click();

    const codeLocator = pageB.locator('.verification-code-display');
    await expect(codeLocator).toBeVisible({ timeout: 20000 });
    await expect(pageB.locator('#password')).not.toBeVisible();

    const verificationCode = (await codeLocator.textContent() || '').trim();
    expect(verificationCode).toMatch(/^[0-9A-F]{6}$/);

    await pageA.goto('/#settings');
    await expect(pageA.getByRole('heading', { name: 'Approve New Device Login' }))
      .toBeVisible({ timeout: 10000 });

    await pageA.locator('input.verification-code-input').fill(verificationCode);
    pageA.once('dialog', dialog => dialog.accept());
    await pageA.getByRole('button', { name: 'Approve Login' }).click();

    await expect(pageB.locator('#password')).toBeVisible({ timeout: 20000 });
    await expect(pageB.locator('.verification-code-display')).not.toBeVisible();

    const storedDeviceId = await pageB.evaluate(() => localStorage.getItem('device_public_id'));
    expect(storedDeviceId).toBeTruthy();

    await pageB.fill('#password', USER.password);
    await pageB.getByRole('button', { name: 'Sign In' }).click();
    await expect(pageB.locator('.home-page')).toBeVisible({ timeout: 20000 });

    await contextA.close();
    await contextB.close();
  });

  test('verified device skips the verification stage', async ({ page }) => {
    await clearBrowserStorage(page);
    await loginAsFirstDevice(page, USER);

    const storedDeviceId = await page.evaluate(() => localStorage.getItem('device_id'));
    expect(storedDeviceId).toBeTruthy();

    await page.evaluate(() => {
      localStorage.removeItem('token');
      localStorage.removeItem('userId');
    });

    await page.goto('/#login');
    await page.fill('#email', USER.email);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('#password')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.verification-code-display')).not.toBeVisible();
  });

  // Gemini's anti-enumeration test - verifies same UI shown for non-existent users
  test('anti-enumeration: non-existent email shows same verification UI', async ({ page }) => {
    await page.goto('/#login');
    await page.fill('#email', 'nonexistent_user_999@example.com');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Should show "Verify this device" even for fake user (anti-enumeration)
    const verifyHeader = page.locator('h2:has-text("Verify this device")');
    await expect(verifyHeader).toBeVisible({ timeout: 5000 });

    // Should show a verification code (even though it will never be approved)
    await expect(page.locator('.verification-code-display')).toBeVisible({ timeout: 5000 });
  });

  test('cancel returns to email stage without revealing password', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await clearBrowserStorage(pageA);
    await loginAsFirstDevice(pageA, USER);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await clearBrowserStorage(pageB);

    await pageB.goto('/#login');
    await pageB.fill('#email', USER.email);
    await pageB.getByRole('button', { name: 'Continue' }).click();

    await expect(pageB.locator('.verification-code-display')).toBeVisible({ timeout: 20000 });

    await pageB.getByRole('button', { name: 'Cancel' }).click();

    await expect(pageB.locator('#email')).toBeVisible({ timeout: 10000 });
    await expect(pageB.locator('.verification-code-display')).not.toBeVisible();
    await expect(pageB.locator('#password')).not.toBeVisible();

    await contextA.close();
    await contextB.close();
  });
});
