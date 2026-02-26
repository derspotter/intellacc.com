const { test, expect } = require('@playwright/test');

// Test data
const USER1 = { email: 'user1@example.com', password: 'password123', name: 'testuser1' };
const USER2 = { email: 'user2@example.com', password: 'password123', name: 'testuser2' };

async function resetServerState() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('./tests/e2e/reset-test-users.sh', () => resolve());
  });
}

async function clearBrowserStorage(page) {
  await page.goto('/#login');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const databases = await indexedDB.databases();
    await Promise.all(databases.map(db => {
      return new Promise(r => {
        if (!db.name) return r();
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = r; req.onerror = r; req.onblocked = r;
      });
    }));
  });
}

async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForFunction(() => window.location.hash === '#home', { timeout: 15000 });
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

async function getUserIdByUsername(page, username) {
  const result = await page.evaluate(async (target) => {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/users/username/${encodeURIComponent(target)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return { error: `Fetch failed: ${res.status}` };
    const data = await res.json();
    return { id: data?.id ?? null };
  }, username);

  if (result.error || !result.id) {
    throw new Error(`Could not resolve user id for ${username}. Details: ${result.error}`);
  }
  return result.id;
}

async function startDirectMessageByUsername(page, username) {
  const targetId = await getUserIdByUsername(page, username);
  console.log(`Resolved ${username} to ID: ${targetId}`);
  return page.evaluate(async (recipientId) => {
    const coreCryptoClient = window.coreCryptoClient;
    const messagingStore = window.__messagingStore || window.messagingStore;
    const result = await coreCryptoClient.startDirectMessage(recipientId);
    console.log(`Direct message started. Group ID: ${result.groupId}`);
    const messagingService = (await import('/src/services/messaging.js')).default;
    const groups = await messagingService.getMlsGroups();
    messagingStore.setMlsGroups(groups);
    messagingStore.selectMlsGroup(result.groupId);
    return result.groupId;
  }, targetId);
}


test.describe('E2E Messaging - Invite Inspection & Key Rotation', () => {

  test.beforeAll(async () => {
    await resetServerState();
  });

  test('User can inspect invite before accepting and rotate keys later', async ({ browser }) => {
    const tempContext = await browser.newContext();
    await clearBrowserStorage(await tempContext.newPage());
    await tempContext.close();

    const contextAlice = await browser.newContext();
    const pageAlice = await contextAlice.newPage();
    pageAlice.on('console', msg => console.log(`Alice: ${msg.text()}`));
    const contextBob = await browser.newContext();
    const pageBob = await contextBob.newPage();
    pageBob.on('console', msg => console.log(`Bob: ${msg.text()}`));

    // Bob logs in and initializes MLS (uploads KeyPackages)
    await loginUser(pageBob, USER2);
    await pageBob.goto('/#messages');
    await pageBob.waitForSelector('.messages-page', { timeout: 15000 });
    // Wait for MLS to initialize
    await pageBob.waitForFunction(() => window.coreCryptoClient?.initialized, null, { timeout: 15000 });

    // Alice logs in and initializes MLS
    await loginUser(pageAlice, USER1);
    await pageAlice.goto('/#messages');
    await pageAlice.waitForSelector('.messages-page', { timeout: 15000 });
    await pageAlice.waitForFunction(() => window.coreCryptoClient?.initialized, null, { timeout: 15000 });

    // Alice starts DM with Bob. Since Bob is initialized, he has KeyPackages on the server.
    await startDirectMessageByUsername(pageAlice, USER2.name);

    // Bob should receive the pending invite via WebSocket or Sync
    const inspectBtn = pageBob.getByRole('button', { name: 'Inspect' });
    await expect(inspectBtn).toBeVisible({ timeout: 15000 });

    // Bob inspects the invite
    await inspectBtn.click();
    const modal = pageBob.locator('.modal-content');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h3', { hasText: 'Inspect Group Invitation' })).toBeVisible();

    // Bob accepts the invite
    const acceptJoinBtn = pageBob.getByRole('button', { name: 'Accept & Join' });
    await acceptJoinBtn.click();
    await expect(modal).not.toBeVisible();

    // Chat should appear in Bob's sidebar
    const convItem = pageBob.locator('.conversation-item, .chat-item, .dm-item').filter({ hasText: USER1.name });
    await expect(convItem).toBeVisible({ timeout: 15000 });

    // Alice tests Key Rotation
    await pageAlice.goto('/#settings');
    await pageAlice.waitForSelector('.settings-page', { timeout: 15000 });

    const refreshBtn = pageAlice.getByRole('button', { name: 'Refresh Encryption Keys' });
    await expect(refreshBtn).toBeVisible({ timeout: 15000 });
    await refreshBtn.click();

    const successMsg = pageAlice.locator('.success-message', { hasText: 'Keys refreshed successfully' });
    await expect(successMsg).toBeVisible({ timeout: 15000 });

    await contextAlice.close();
    await contextBob.close();
  });
});
