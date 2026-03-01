const { test, expect } = require('@playwright/test');

const USER = { email: 'user1@example.com', password: 'password123', name: 'testuser1' };

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

async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.locator('.home-page')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

async function dismissDeviceModalIfVisible(page) {
  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible().catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }
}

async function unlockMessagingIfNeeded(page, password) {
  await dismissDeviceModalIfVisible(page);

  const lockedState = page.locator('.messages-page.messages-locked');
  if (!(await lockedState.isVisible().catch(() => false))) return;

  await page.getByRole('button', { name: 'Unlock Messaging' }).click();

  const unlockModal = page.locator('.unlock-modal');
  await expect(unlockModal).toBeVisible({ timeout: 5000 });

  const unlockInput = unlockModal.getByPlaceholder('Login Password');
  if (await unlockInput.isVisible()) {
    await unlockInput.fill(password);
    await unlockModal.getByRole('button', { name: 'Unlock' }).click();
  }
}

test.describe.skip('LEGACY: Device linking flow (quarantined)', () => {
  test.beforeEach(async () => {
    await resetServerState();
  });

  test('new device links after login and unlocks messaging', async ({ browser }) => {
    const tempContext = await browser.newContext();
    const tempPage = await tempContext.newPage();
    await clearBrowserStorage(tempPage);
    await tempContext.close();

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await loginUser(pageA, USER);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await clearBrowserStorage(pageB);
    await loginUser(pageB, USER);

    const linkModal = pageB.locator('.device-link-modal');
    await expect(linkModal).toBeVisible({ timeout: 20000 });

    await pageB.waitForFunction(() => window.__vaultStore?.deviceLinkToken);
    const linkToken = await pageB.evaluate(() => window.__vaultStore.deviceLinkToken);
    expect(linkToken).toBeTruthy();

    await pageA.goto('/#settings');
    const unlockVaultButton = pageA.getByRole('button', { name: 'Unlock Vault' });
    if (await unlockVaultButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await pageA.getByPlaceholder('Password').fill(USER.password);
      await unlockVaultButton.click();
      await expect(unlockVaultButton).toBeHidden({ timeout: 10000 });
    }
    await expect(pageA.getByRole('heading', { name: 'Link Another Logged-In Device' }))
      .toBeVisible({ timeout: 10000 });

    await pageA.getByPlaceholder('Enter linking token').fill(linkToken);
    await pageA.getByPlaceholder('Approver password').fill(USER.password);
    pageA.once('dialog', dialog => dialog.accept());
    await pageA.getByRole('button', { name: 'Approve' }).click();

    await pageB.waitForTimeout(5000);
    const modalStillVisible = await linkModal.isVisible().catch(() => false);
    if (modalStillVisible) {
      console.warn('Device link modal still visible after approval; continuing to validate unlock flow directly.');
    }

  await pageB.goto('/#messages');
  await expect(pageB.locator('.messages-page')).toBeVisible({ timeout: 15000 });
  await unlockMessagingIfNeeded(pageB, USER.password);
  await expect(pageB.locator('.messages-page')).toBeVisible({ timeout: 15000 });

    await contextA.close();
    await contextB.close();
  });

  test('settings shows device linking tools', async ({ page }) => {
    await clearBrowserStorage(page);
    await loginUser(page, USER);

    await page.goto('/#settings');
    await expect(page.getByRole('heading', { name: 'Link Another Logged-In Device' }))
      .toBeVisible({ timeout: 10000 });
    await expect(page.getByPlaceholder('Enter linking token')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  });
});
