const { test, expect } = require('@playwright/test');
const path = require('path');

const PASSWORD = 'password123';

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
  });

  await page.waitForTimeout(500);
}

async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

test('Users can share an attachment via MLS messaging', async ({ browser, request }) => {
  await resetServerState();

  const USER1 = {
    email: 'user1@example.com',
    password: PASSWORD,
    name: 'testuser1'
  };
  const USER2 = {
    email: 'user2@example.com',
    password: PASSWORD,
    name: 'testuser2'
  };

  const ensureUsers = async (user) => {
    const res = await request.post('/api/login', {
      data: { email: user.email, password: user.password }
    });
    if (!res.ok()) {
      throw new Error(`Expected seeded test user ${user.email} to be available`);
    }
  };

  await ensureUsers(USER1);
  await ensureUsers(USER2);
  const tempContext = await browser.newContext();
  const tempPage = await tempContext.newPage();
  await clearBrowserStorage(tempPage);
  await tempContext.close();

  const contextAlice = await browser.newContext();
  const pageAlice = await contextAlice.newPage();

  const contextBob = await browser.newContext();
  const pageBob = await contextBob.newPage();

  await loginUser(pageAlice, USER1);
  await loginUser(pageBob, USER2);

  const filePath = path.resolve(__dirname, 'fixtures/pixel.png');

  await pageAlice.goto('/#messages');
  await pageAlice.waitForSelector('.messages-page', { timeout: 15000 });

  // If device link modal is shown, cancel to avoid overlay
  const deviceModal = pageAlice.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }

  // If messages are locked, unlock with password
  const lockedState = pageAlice.locator('.messages-page.messages-locked');
  if (await lockedState.isVisible({ timeout: 2000 }).catch(() => false)) {
    await pageAlice.getByRole('button', { name: 'Unlock Messaging' }).click();
    const unlockModal = pageAlice.locator('.unlock-modal');
    await expect(unlockModal).toBeVisible({ timeout: 5000 });
    const unlockInput = unlockModal.getByPlaceholder('Login Password');
    if (await unlockInput.isVisible().catch(() => false)) {
      await unlockInput.fill(USER1.password);
      await unlockModal.getByRole('button', { name: 'Unlock' }).click();
    }
    await expect(pageAlice.locator('.messages-page.messages-locked')).toBeHidden({ timeout: 10000 });
  }

  const newBtn = pageAlice.locator('button:has-text("+ New"), button:has-text("New")');
  await newBtn.click();

  const searchInput = pageAlice.locator('input[placeholder*="Search"], input[placeholder*="search"]');
  await searchInput.fill(USER2.name);

  const userRow = pageAlice.locator('.user-row, .user-item, [data-user]').filter({ hasText: USER2.name });
  await expect(userRow).toBeVisible({ timeout: 10000 });
  await userRow.click();

  const startDmBtn = pageAlice.locator('button:has-text("Start DM"), button:has-text("Start"), button:has-text("Message")');
  await startDmBtn.click();

  await expect(pageAlice.locator('.chat-title').first()).toContainText(USER2.name, { timeout: 10000 });

  const msgFromAlice = `Attachment ${Date.now()}`;
  const textarea = pageAlice.locator('.message-textarea');
  await textarea.fill(msgFromAlice);
  await pageAlice.locator('.message-attachment-input').setInputFiles(filePath);
  await pageAlice.locator('.send-button').click();
  await expect(pageAlice.locator('.message-item.sent .message-attachment')).toBeVisible({ timeout: 15000 });

  await pageBob.goto('/#messages');
  await pageBob.waitForSelector('.messages-page', { timeout: 15000 });

  const bobDeviceModal = pageBob.locator('.device-link-modal');
  if (await bobDeviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await bobDeviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(bobDeviceModal).toBeHidden({ timeout: 5000 });
  }

  const bobLockedState = pageBob.locator('.messages-page.messages-locked');
  if (await bobLockedState.isVisible({ timeout: 2000 }).catch(() => false)) {
    await pageBob.getByRole('button', { name: 'Unlock Messaging' }).click();
    const unlockModal = pageBob.locator('.unlock-modal');
    await expect(unlockModal).toBeVisible({ timeout: 5000 });
    const unlockInput = unlockModal.getByPlaceholder('Login Password');
    if (await unlockInput.isVisible().catch(() => false)) {
      await unlockInput.fill(USER2.password);
      await unlockModal.getByRole('button', { name: 'Unlock' }).click();
    }
    await expect(pageBob.locator('.messages-page.messages-locked')).toBeHidden({ timeout: 10000 });
  }

  const acceptResult = await pageBob.evaluate(async () => {
    const coreCryptoClient = window.coreCryptoClient;
    if (!coreCryptoClient) return { error: 'coreCryptoClient not on window' };

    const pending = coreCryptoClient.pendingWelcomes;
    if (pending.size === 0) return { error: 'No pending welcomes' };

    const [pendingId, invite] = pending.entries().next().value;
    try {
      const groupId = await coreCryptoClient.acceptWelcome(invite);
      await coreCryptoClient.syncMessages();
      return { success: true, groupId };
    } catch (e) {
      return { error: e.message };
    }
  });
  expect(acceptResult.error).toBeFalsy();

  const convItem = pageBob.locator('.conversation-item, .chat-item, .dm-item').filter({ hasText: USER1.name });
  await expect(convItem).toBeVisible({ timeout: 15000 });
  await convItem.click();

  await expect(pageBob.locator('.message-item.received .message-attachment')).toBeVisible({ timeout: 15000 });

  const descriptor = await pageBob.evaluate(() => {
    const messages = window.messagingStore?.currentMlsMessages || [];
    const attachmentMsg = messages.find(m => {
      try {
        const parsed = JSON.parse(m.plaintext || '');
        return parsed?.type === 'attachment';
      } catch {
        return false;
      }
    });
    return attachmentMsg ? JSON.parse(attachmentMsg.plaintext) : null;
  });
  expect(descriptor?.attachmentId).toBeTruthy();

  const bobToken = await pageBob.evaluate(() => localStorage.getItem('token'));
  expect(bobToken).toBeTruthy();
  const fetchUrl = `http://localhost:3000/api/attachments/${descriptor.attachmentId}`;
  const assetResponse = await pageBob.request.get(fetchUrl, {
    headers: { Authorization: `Bearer ${bobToken}` }
  });
  expect(assetResponse.ok()).toBeTruthy();
});
