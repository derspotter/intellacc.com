const { test, expect } = require('@playwright/test');
const path = require('path');

const PASSWORD = 'password123';

async function clearBrowserStorage(page) {
  await page.goto('/#login');
  await page.waitForTimeout(500);

  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();

    if (indexedDB?.databases) {
      const databases = await indexedDB.databases();
      const deletePromises = databases.map(db => {
        return new Promise((resolve) => {
          if (!db.name) return resolve();
          const req = indexedDB.deleteDatabase(db.name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      });
      await Promise.all(deletePromises);
    }
  });

  await page.waitForTimeout(500);
}

async function registerUser(request, user) {
  const res = await request.post('http://127.0.0.1:3000/api/users/register', {
    data: { username: user.name, email: user.email, password: user.password }
  });

  if (!res.ok()) {
    const text = await res.text();
    if (!text.includes('already exists')) {
      throw new Error(`Failed to register ${user.email}: ${text}`);
    }
  }
}

async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.getByRole('button', { name: 'Continue' }).click();

  const passwordInput = page.locator('#password');
  await expect(passwordInput).toBeVisible({ timeout: 15000 });
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

async function unlockMessagingIfNeeded(page, password) {
  const lockedState = page.locator('.messages-page.messages-locked');
  if (await lockedState.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.getByRole('button', { name: 'Unlock Messaging' }).click();
    const unlockModal = page.locator('.unlock-modal');
    await expect(unlockModal).toBeVisible({ timeout: 5000 });
    await unlockModal.getByPlaceholder('Login Password').fill(password);
    await unlockModal.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('.messages-page.messages-locked')).toBeHidden({ timeout: 15000 });
  }

  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }
}

test('User can send and download an attachment in an MLS group', async ({ browser, request }) => {
  const suffix = Date.now();
  const USER = {
    email: `msgui_${suffix}@example.com`,
    password: PASSWORD,
    name: `msgui_${suffix}`
  };

  await registerUser(request, USER);

  const tempContext = await browser.newContext();
  const tempPage = await tempContext.newPage();
  await clearBrowserStorage(tempPage);
  await tempContext.close();

  const context = await browser.newContext();
  const page = await context.newPage();

  await loginUser(page, USER);

  await page.goto('/#messages');
  await page.waitForSelector('.messages-page', { timeout: 15000 });
  await unlockMessagingIfNeeded(page, USER.password);

  const groupName = `Attachment UI Group ${Date.now()}`;
  const groupId = await page.evaluate(async (name) => {
    const coreCryptoClient = window.coreCryptoClient;
    const store = window.__messagingStore || window.messagingStore;
    if (!coreCryptoClient || !store) throw new Error('Messaging not ready');

    await coreCryptoClient.ensureReady();
    const group = await coreCryptoClient.createGroup(name);

    const messagingService = (await import('/src/services/messaging.js')).default;
    const groups = await messagingService.getMlsGroups();
    store.setMlsGroups(groups);
    store.selectMlsGroup(group.group_id);

    return group.group_id;
  }, groupName);

  expect(groupId).toBeTruthy();

  const groupItem = page.locator('.conversation-item.mls-group').filter({ hasText: groupName });
  await expect(groupItem).toBeVisible({ timeout: 15000 });
  await groupItem.click();

  const filePath = path.resolve(__dirname, 'fixtures/pixel.png');
  await page.locator('.message-attachment-input').setInputFiles(filePath);
  await page.locator('.message-textarea').fill(`Attachment UI send test ${Date.now()}`);
  await page.locator('.send-button').click();

  const attachmentMessage = page.locator('.message-item.sent .message-attachment');
  await expect(attachmentMessage).toBeVisible({ timeout: 20000 });
  await expect(attachmentMessage).toContainText('pixel.png');

  const downloadButton = attachmentMessage.getByRole('button', { name: 'Download' });
  await downloadButton.click();

  const previewImage = attachmentMessage.locator('.attachment-preview img');
  await expect(previewImage).toBeVisible({ timeout: 15000 });
});
