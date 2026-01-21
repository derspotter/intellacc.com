const { test, expect } = require('@playwright/test');

// Test data
const USER1 = { email: 'user1@example.com', password: 'password123', name: 'testuser1' };
const USER2 = { email: 'user2@example.com', password: 'password123', name: 'testuser2' };

/**
 * Reset server-side state for test users via shell script
 */
async function resetServerState() {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
        exec('./tests/e2e/reset-test-users.sh', (error, stdout, stderr) => {
            if (error) {
                console.warn('Reset script warning:', stderr);
            }
            console.log('Server state reset:', stdout.includes('Reset complete'));
            resolve();
        });
    });
}

/**
 * Clear all browser storage (IndexedDB, localStorage, sessionStorage)
 */
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

/**
 * Helper to log in a user (staged login flow)
 */
async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.getByRole('button', { name: 'Continue' }).click();

  const passwordInput = page.locator('#password');
  await expect(passwordInput).toBeVisible({ timeout: 15000 });
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.locator('.home-page')).toBeVisible({ timeout: 10000 });
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

test.describe('E2E Messaging', () => {

  test.beforeAll(async () => {
    // Reset server state once before all tests in this file
    await resetServerState();
  });

  test('Two users can exchange encrypted messages and history is persisted', async ({ browser }) => {
    // Clear browser storage for both contexts before starting
    const tempContext = await browser.newContext();
    const tempPage = await tempContext.newPage();
    await clearBrowserStorage(tempPage);
    await tempContext.close();
    // --- 1. Setup Contexts (Two separate browsers/devices) ---
    const contextAlice = await browser.newContext();
    const pageAlice = await contextAlice.newPage();

    const contextBob = await browser.newContext();
    const pageBob = await contextBob.newPage();

    // --- 2. Login Both Users ---
    console.log('Logging in Alice...');
    await loginUser(pageAlice, USER1);

    console.log('Logging in Bob...');
    await loginUser(pageBob, USER2);

    // --- 3. Alice starts DM with Bob ---
    console.log('Alice starting DM...');

    // Capture console logs early
    const aliceConsoleLogs = [];
    pageAlice.on('console', msg => aliceConsoleLogs.push(`${msg.type()}: ${msg.text()}`));

    await pageAlice.goto('/#messages');
    await pageAlice.waitForSelector('.messages-page', { timeout: 15000 });

    // Debug: Check MLS state after navigating to messages
    const mlsInitState = await pageAlice.evaluate(() => {
      const store = window.messagingStore;
      return {
        mlsGroups: store?.mlsGroups?.length,
        currentUserId: store?.currentUserId,
        mlsInitialized: window.coreCryptoClient?.initialized
      };
    });
    console.log('MLS state after messages page load:', mlsInitState);
    console.log('Console logs so far:', aliceConsoleLogs.filter(l => l.includes('MLS') || l.includes('error') || l.includes('Error')));

    // Click new message button
    const newBtn = pageAlice.locator('button:has-text("+ New"), button:has-text("New")');
    await newBtn.click();

    // Search for Bob
    const searchInput = pageAlice.locator('input[placeholder*="Search"], input[placeholder*="search"]');
    await searchInput.fill(USER2.name);

    // Wait for result and select
    const userRow = pageAlice.locator('.user-row, .user-item, [data-user]').filter({ hasText: USER2.name });
    await expect(userRow).toBeVisible({ timeout: 10000 });
    await userRow.click();

    // Start DM
    const startDmBtn = pageAlice.locator('button:has-text("Start DM"), button:has-text("Start"), button:has-text("Message")');
    await startDmBtn.click();

    // Debug: Check MLS state after starting DM
    const mlsAfterDm = await pageAlice.evaluate(() => {
      const store = window.messagingStore;
      return {
        selectedMlsGroupId: store?.selectedMlsGroupId,
        mlsGroups: store?.mlsGroups?.length,
        currentUserId: store?.currentUserId,
        mlsInitialized: window.coreCryptoClient?.initialized
      };
    });
    console.log('MLS state after starting DM:', mlsAfterDm);
    console.log('Console logs after DM:', aliceConsoleLogs.filter(l => l.includes('MLS') || l.includes('error') || l.includes('Error') || l.includes('DM')).slice(-15));

    // Check if chat opened
    await expect(pageAlice.locator('.chat-title').first()).toContainText(USER2.name, { timeout: 10000 });

    // --- 4. Alice sends message ---
    console.log('Alice sending message...');
    const msgFromAlice = `Hello Bob ${Date.now()}`;

    // Debug: Check MLS state before sending
    const mlsState = await pageAlice.evaluate(() => {
      const store = window.messagingStore;
      return {
        selectedMlsGroupId: store?.selectedMlsGroupId,
        newMessage: store?.newMessage,
        mlsGroups: store?.mlsGroups?.length,
        currentUserId: store?.currentUserId
      };
    });
    console.log('MLS state before send:', mlsState);

    // Type text using pressSequentially to ensure input events fire
    const textarea = pageAlice.locator('.message-textarea');
    await textarea.click();
    await textarea.pressSequentially(msgFromAlice, { delay: 10 });

    // Debug: Check state after typing
    const stateAfterType = await pageAlice.evaluate(() => ({
      newMessage: window.messagingStore?.newMessage,
      selectedMlsGroupId: window.messagingStore?.selectedMlsGroupId
    }));
    console.log('State after typing:', stateAfterType);

    // Click send button instead of Enter (more explicit)
    await pageAlice.locator('.send-button').click();

    // Capture any console errors
    const consoleLogs = [];
    pageAlice.on('console', msg => consoleLogs.push(`${msg.type()}: ${msg.text()}`));

    // Verify Alice sees her own message (wait a bit for encryption/send)
    console.log('Browser console logs:', consoleLogs.slice(-10));

    // Debug: take screenshot
    await pageAlice.screenshot({ path: 'test-results/alice-after-send.png' });
    // Check what's visible in the chat area
    const chatContent = await pageAlice.locator('.chat-messages, .messages-list, .message-list').innerHTML().catch(() => 'not found');
    console.log('Chat content:', chatContent.substring(0, 500));
    await expect(pageAlice.locator('.message-item.sent .message-text')).toContainText(msgFromAlice, { timeout: 15000 });

    // --- 5. Bob receives message ---
    console.log('Bob checking for message...');
    await pageBob.goto('/#messages');
    await pageBob.waitForSelector('.messages-page', { timeout: 15000 });

    // Bob needs to accept the welcome first (welcome holdback mechanism)
    console.log('Bob accepting welcome...');
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
    console.log('Accept result:', acceptResult);

    // Bob should now see the DM in sidebar
    const convItem = pageBob.locator('.conversation-item, .chat-item, .dm-item').filter({ hasText: USER1.name });
    await expect(convItem).toBeVisible({ timeout: 15000 });
    await convItem.click();

    // Verify Bob sees Alice's message
    await expect(pageBob.locator('.message-item.received .message-text')).toContainText(msgFromAlice, { timeout: 15000 });

    // --- 6. Bob replies ---
    console.log('Bob replying...');
    const msgFromBob = `Hello Alice ${Date.now()}`;
    await pageBob.locator('.message-textarea').fill(msgFromBob);
    await pageBob.locator('.send-button').click();
    await expect(pageBob.locator('.message-item.sent .message-text')).toContainText(msgFromBob, { timeout: 15000 });

    // --- 7. Alice receives reply ---
    console.log('Alice checking for reply...');
    await expect(pageAlice.locator('.message-item.received .message-text')).toContainText(msgFromBob, { timeout: 15000 });

    // --- 8. Persistence Test (Alice Logout/Login) ---
    console.log('Testing persistence...');

    // Alice Logs Out (clear token but keep IndexedDB)
    await pageAlice.evaluate(() => {
        localStorage.removeItem('token');
        location.hash = '#login';
    });
    await pageAlice.waitForURL('**/#login');

    // Alice Logs In Again
    await loginUser(pageAlice, USER1);

    // Check Messages
    await pageAlice.goto('/#messages');
    await pageAlice.waitForSelector('.messages-page', { timeout: 15000 });

    const convItemAlice = pageAlice.locator('.conversation-item, .chat-item, .dm-item').filter({ hasText: USER2.name });
    await expect(convItemAlice).toBeVisible({ timeout: 10000 });
    await convItemAlice.click();

    // History should be there (decrypted from local vault)
    await expect(pageAlice.locator('.message-text').filter({ hasText: msgFromAlice })).toBeVisible({ timeout: 10000 });
    await expect(pageAlice.locator('.message-text').filter({ hasText: msgFromBob })).toBeVisible({ timeout: 10000 });

    console.log('Test Complete: Messaging and Persistence verified.');

    // Cleanup
    await contextAlice.close();
    await contextBob.close();
  });

});
