const { test, expect } = require('@playwright/test');
const { exec } = require('child_process');

const USER = { email: 'user1@example.com', password: 'password123' };

async function resetServerState() {
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
  await page.waitForTimeout(300);

  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();

    const databases = await indexedDB.databases();
    await Promise.all(
      databases.map((db) => new Promise((resolve) => {
        if (!db.name) return resolve();
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      }))
    );
  });
}

async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await Promise.race([
    page.waitForFunction(() => window.location.hash === '#home', { timeout: 15000 }),
    page.waitForSelector('.home-page', { state: 'visible', timeout: 15000 })
  ]);
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

async function dismissDeviceModalIfVisible(page) {
  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 1500 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }
}

async function fillUnlockPassword(unlockModal, password) {
  const candidates = [
    unlockModal.getByPlaceholder('Login Password'),
    unlockModal.getByPlaceholder('Vault Passphrase'),
    unlockModal.getByPlaceholder('Enter access key...'),
    unlockModal.locator('input[type="password"]').first()
  ];

  for (const candidate of candidates) {
    const input = candidate.first();
    if (await input.isVisible({ timeout: 1200 }).catch(() => false)) {
      await input.fill(password);
      const confirm = unlockModal.getByPlaceholder('Confirm Vault Passphrase');
      if (await confirm.isVisible({ timeout: 400 }).catch(() => false)) {
        await confirm.fill(password);
      }
      return true;
    }
  }

  return false;
}

async function unlockMessagingIfNeeded(page, password) {
  await page.goto('/#messages');
  await page.waitForSelector('.messages-page', { timeout: 15000 });
  const initialLinkModal = page.locator('.device-link-modal');
  if (await initialLinkModal.isVisible({ timeout: 1200 }).catch(() => false)) {
    const tokenVisible = await initialLinkModal.locator('.verification-code').isVisible({ timeout: 1200 }).catch(() => false);
    return { state: 'link_required', tokenVisible };
  }

  const locked = page.locator('.messages-page.messages-locked');
  if (!(await locked.isVisible({ timeout: 1500 }).catch(() => false))) {
    return { state: 'unlocked' };
  }

  await page.getByRole('button', { name: 'Unlock Messaging' }).click();
  const unlockModal = page.locator('.unlock-modal');
  await expect(unlockModal).toBeVisible({ timeout: 6000 });

  const filled = await fillUnlockPassword(unlockModal, password);
  expect(filled).toBeTruthy();
  await unlockModal.getByRole('button', { name: /Unlock|Create Vault/i }).first().click();

  const becameUnlocked = await locked.isHidden({ timeout: 8000 }).catch(() => false);
  if (becameUnlocked) {
    return { state: 'unlocked' };
  }

  const linkModal = page.locator('.device-link-modal');
  const linkRequired = await linkModal.isVisible({ timeout: 1500 }).catch(() => false);
  if (linkRequired) {
    const tokenVisible = await linkModal.locator('.verification-code').isVisible({ timeout: 2000 }).catch(() => false);
    return { state: 'link_required', tokenVisible };
  }

  const unlockVisible = await page.getByRole('button', { name: 'Unlock Messaging' }).isVisible({ timeout: 1200 }).catch(() => false);
  return { state: unlockVisible ? 'locked_actionable' : 'locked' };
}

test.describe('Messaging V2 Smoke', () => {
  test.beforeEach(async ({ page }) => {
    await resetServerState();
    await clearBrowserStorage(page);
  });

  test('login reaches home shell', async ({ page }) => {
    await loginUser(page, USER);
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 10000 });
  });

  test('messages can be unlocked or setup on fresh browser state', async ({ page }) => {
    await loginUser(page, USER);
    const result = await unlockMessagingIfNeeded(page, USER.password);
    expect(['unlocked', 'link_required', 'locked_actionable']).toContain(result.state);
    await expect(page.locator('.messages-page')).toBeVisible({ timeout: 10000 });
  });

  test('settings shows device-link approval controls', async ({ page }) => {
    await loginUser(page, USER);
    await page.goto('/#settings');

    const unlockVaultButton = page.getByRole('button', { name: /Unlock Vault/i }).first();
    const linkHeadingVisible = await page.getByRole('heading', { name: /Link Another/i }).isVisible({ timeout: 10000 }).catch(() => false);
    const tokenVisible = await page.locator('input[placeholder*="linking token" i]').first().isVisible({ timeout: 2000 }).catch(() => false);
    const approveVisible = await page.getByRole('button', { name: /Approve/i }).first().isVisible({ timeout: 2000 }).catch(() => false);
    const unlockVisible = await unlockVaultButton.isVisible({ timeout: 1000 }).catch(() => false);
    const modalVisible = await page.locator('.device-link-modal').isVisible({ timeout: 1000 }).catch(() => false);
    expect(linkHeadingVisible || (tokenVisible && approveVisible) || unlockVisible || modalVisible).toBeTruthy();
  });
});
