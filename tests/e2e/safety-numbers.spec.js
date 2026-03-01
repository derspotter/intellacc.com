const { test, expect } = require('@playwright/test');

/**
 * E2E Tests for Safety Numbers / Trust Layer
 *
 * Tests the TOFU (Trust on First Use) verification flow:
 * - Fingerprint capture on first contact
 * - Verification badge display
 * - Contact verification modal
 * - Fingerprint change warning
 */

// Test users (from test environment)
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
  await page.fill('#password', user.password);

  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.locator('.home-page')).toBeVisible({ timeout: 10000 });
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

async function ensureMessagesUnlocked(page, password) {
  await page.goto('/#messages');
  await page.waitForSelector('.messages-page', { timeout: 15000 });

  const lockedState = page.locator('.messages-locked');
  if (await lockedState.isVisible()) {
    const unlockButton = page.getByRole('button', { name: 'Unlock Messaging' });
    await unlockButton.click();
    await expect(page.getByPlaceholder('Login Password')).toBeVisible({ timeout: 10000 });
    await page.getByPlaceholder('Login Password').fill(password);
    await page.locator('.unlock-modal').getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('.unlock-modal')).toBeHidden({ timeout: 15000 });
    await expect(page.locator('.messages-locked')).toBeHidden({ timeout: 15000 });
  }
}

async function getAuthedUserId(page) {
  return await page.evaluate(async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return null;
      const res = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.id ?? null;
    } catch (e) {
      return null;
    }
  });
}

async function getUserIdByUsername(page, username) {
  return await page.evaluate(async (targetUsername) => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return null;
      const res = await fetch(`/api/users/username/${encodeURIComponent(targetUsername)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.id ?? null;
    } catch (e) {
      return null;
    }
  }, username);
}

/**
 * Helper to start a DM between two users
 */
async function startDmWithUser(page, targetUser) {
  await ensureMessagesUnlocked(page, USER1.password);

  // Click new message button
  const newBtn = page.locator('button:has-text("+ New"), button:has-text("New")');
  await newBtn.click();

  // Search for target user
  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]');
  await searchInput.fill(targetUser.name);

  // Wait for result and select
  const userRow = page.locator('.user-row, .user-item, [data-user]').filter({ hasText: targetUser.name });
  await expect(userRow).toBeVisible({ timeout: 10000 });
  await userRow.click();

  // Start DM
  const startDmBtn = page.locator('button:has-text("Start DM"), button:has-text("Start"), button:has-text("Message")');
  await startDmBtn.click();

  await expect(page.locator('.chat-title').first()).toContainText(targetUser.name, { timeout: 10000 });
}

test.describe.skip('LEGACY: Safety Numbers / TOFU Verification (quarantined)', () => {

  test.beforeEach(async () => {
    await resetServerState();
  });

  test('should record contact fingerprint on first message exchange', async ({ browser }) => {
    // Setup: Clear storage and create fresh contexts
    const tempContext = await browser.newContext();
    const tempPage = await tempContext.newPage();
    await clearBrowserStorage(tempPage);
    await tempContext.close();

    const contextAlice = await browser.newContext();
    const pageAlice = await contextAlice.newPage();

    const contextBob = await browser.newContext();
    const pageBob = await contextBob.newPage();

    try {
      // Login both users
      await loginUser(pageAlice, USER1);
      await loginUser(pageBob, USER2);

      const aliceId = await getAuthedUserId(pageAlice);
      const bobId = await getAuthedUserId(pageBob);
      expect(aliceId).toBeTruthy();
      expect(bobId).toBeTruthy();

      // Alice starts DM with Bob
      await startDmWithUser(pageAlice, USER2);

      // Alice sends a message (triggers fingerprint capture on Bob's side)
      const testMessage = `Test message ${Date.now()}`;
      await pageAlice.locator('.message-textarea').click();
      await pageAlice.locator('.message-textarea').pressSequentially(testMessage, { delay: 10 });
      await pageAlice.locator('.send-button').click();
      await expect(pageAlice.locator('.message-item.sent .message-text'))
        .toContainText(testMessage, { timeout: 15000 });

      // Bob accepts welcome and receives message
      await ensureMessagesUnlocked(pageBob, USER2.password);

      // Bob accepts the pending welcome
      await pageBob.evaluate(async () => {
        const coreCryptoClient = window.coreCryptoClient;
        if (!coreCryptoClient) return { error: 'coreCryptoClient not on window' };

        const pending = coreCryptoClient.pendingWelcomes;
        if (pending.size === 0) return { status: 'no_pending' };

        const [pendingId, invite] = pending.entries().next().value;
        try {
          const groupId = await coreCryptoClient.acceptWelcome(invite);
          await coreCryptoClient.syncMessages();
          return { success: true, groupId };
        } catch (e) {
          return { error: e.message };
        }
      });

      await pageBob.waitForTimeout(2000);

      // Verify Alice's vault has Bob's fingerprint stored
      const aliceFingerprintData = await pageAlice.evaluate(async (contactId) => {
        const coreCryptoClient = window.coreCryptoClient;
        if (!coreCryptoClient?.getVaultService) return { status: 'vault_unavailable' };

        const vaultService = await coreCryptoClient.getVaultService();
        if (!vaultService) return { status: 'vault_unavailable' };

        try {
          if (!contactId) return { status: 'not_found' };
          const fingerprint = await vaultService.getContactFingerprint(contactId);
          return fingerprint || { status: 'not_found' };
        } catch (e) {
          return { error: e.message };
        }
      }, bobId);

      console.log('Alice fingerprint data for Bob:', aliceFingerprintData);

      // Verify Bob's vault has Alice's fingerprint stored
      const bobFingerprintData = await pageBob.evaluate(async (contactId) => {
        const coreCryptoClient = window.coreCryptoClient;
        if (!coreCryptoClient?.getVaultService) return { status: 'vault_unavailable' };

        const vaultService = await coreCryptoClient.getVaultService();
        if (!vaultService) return { status: 'vault_unavailable' };

        try {
          if (!contactId) return { status: 'not_found' };
          const fingerprint = await vaultService.getContactFingerprint(contactId);
          return fingerprint || { status: 'not_found' };
        } catch (e) {
          return { error: e.message };
        }
      }, aliceId);

      console.log('Bob fingerprint data for Alice:', bobFingerprintData);

      // Assertions - when feature is implemented:
      // expect(aliceFingerprintData.status).toBe('unverified');
      // expect(aliceFingerprintData.fingerprint).toBeDefined();
      // expect(bobFingerprintData.status).toBe('unverified');
      // expect(bobFingerprintData.fingerprint).toBeDefined();

    } finally {
      await contextAlice.close();
      await contextBob.close();
    }
  });

  test('should display Safety Numbers button in chat header', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginUser(page, USER1);
      await ensureMessagesUnlocked(page, USER1.password);

      // Select an existing conversation (if any)
      const convItem = page.locator('.conversation-item, .chat-item').first();
      if (await convItem.isVisible()) {
        await convItem.click();
        await page.waitForTimeout(1000);

        // Look for Safety Numbers button in header
        const safetyBtn = page.locator('.btn-safety-numbers, button[title*="Safety"], button:has-text("🛡️")');

        // When feature is implemented:
        // await expect(safetyBtn).toBeVisible();
        console.log('Safety button visible:', await safetyBtn.isVisible());
      }

    } finally {
      await context.close();
    }
  });

  test('should show own safety number in modal', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginUser(page, USER1);
      await ensureMessagesUnlocked(page, USER1.password);

      // Select a conversation
      const convItem = page.locator('.conversation-item, .chat-item').first();
      if (await convItem.isVisible()) {
        await convItem.click();
        await page.waitForTimeout(1000);

        // Click Safety Numbers button
        const safetyBtn = page.locator('.btn-safety-numbers, button[title*="Safety"], button:has-text("🛡️")');
        if (await safetyBtn.isVisible()) {
          await safetyBtn.click();
          await page.waitForTimeout(500);

          // Modal should appear with fingerprint
          const modal = page.locator('.safety-numbers-modal');
          await expect(modal).toBeVisible({ timeout: 5000 });

          // Should display hex fingerprint
          const hexDisplay = page.locator('.fingerprint-hex, .fingerprint-display');
          await expect(hexDisplay).toBeVisible();

          // Fingerprint should have proper format (spaces every 4 chars)
          const hexText = await hexDisplay.textContent();
          console.log('Safety number hex:', hexText);

          // Should match pattern like "ABCD 1234 EF56 ..."
          expect(hexText).toMatch(/[A-F0-9\s]+/i);
        }
      }

    } finally {
      await context.close();
    }
  });

  test('should show verification badge for DM contacts', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginUser(page, USER1);
      await ensureMessagesUnlocked(page, USER1.password);

      // Look for verification badges in conversation list
      const verifiedBadge = page.locator('.verification-badge.verified, .verified-badge');
      const unverifiedBadge = page.locator('.verification-badge.unverified');
      const changedBadge = page.locator('.verification-badge.warning, .verification-badge.changed');

      // When feature is implemented, at least one type should be visible
      const hasAnyBadge =
        await verifiedBadge.count() > 0 ||
        await unverifiedBadge.count() > 0 ||
        await changedBadge.count() > 0;

      console.log('Verification badges found:', {
        verified: await verifiedBadge.count(),
        unverified: await unverifiedBadge.count(),
        changed: await changedBadge.count()
      });

      // When feature is implemented:
      // expect(hasAnyBadge).toBe(true);

    } finally {
      await context.close();
    }
  });

  test('should open contact verification modal and allow marking as verified', async ({ browser }) => {
    const contextAlice = await browser.newContext();
    const pageAlice = await contextAlice.newPage();

    try {
      await loginUser(pageAlice, USER1);
      await ensureMessagesUnlocked(pageAlice, USER1.password);

      // Select DM with Bob
      const convItem = pageAlice.locator('.conversation-item, .chat-item').filter({ hasText: USER2.name });
      if (await convItem.isVisible()) {
        await convItem.click();
        await pageAlice.waitForTimeout(1000);

        // Click "Verify Contact" button
        const verifyBtn = pageAlice.locator('button:has-text("Verify"), .btn-verify-contact');
        if (await verifyBtn.isVisible()) {
          await verifyBtn.click();
          await pageAlice.waitForTimeout(500);

          // Contact verification modal should open
          const modal = pageAlice.locator('.contact-verification, .verification-modal');
          await expect(modal).toBeVisible({ timeout: 5000 });

          // Should show both fingerprints (yours and theirs)
          const yourFingerprint = modal.locator('.fingerprint-section.yours, .your-fingerprint');
          const theirFingerprint = modal.locator('.fingerprint-section.theirs, .their-fingerprint');

          await expect(yourFingerprint).toBeVisible();
          await expect(theirFingerprint).toBeVisible();

          // Click "Mark as Verified" button
          const markVerifiedBtn = modal.locator('button:has-text("Mark as Verified"), .verify-btn');
          if (await markVerifiedBtn.isVisible()) {
            await markVerifiedBtn.click();
            await pageAlice.waitForTimeout(1000);

            // Should show verified status
            const verifiedStatus = modal.locator('.verified-badge, .status-verified');
            await expect(verifiedStatus).toBeVisible();
          }
        }
      }

    } finally {
      await contextAlice.close();
    }
  });

  test('should show warning when fingerprint changes (MITM detection)', async ({ browser }) => {
    // This test simulates a fingerprint change scenario
    // In real scenario, this happens when user reinstalls or attacker is present

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginUser(page, USER1);

      // Manually simulate fingerprint change in vault
      const warningTriggered = await page.evaluate(async () => {
        const vaultService = window.vaultService;
        if (!vaultService) return false;

        // Simulate: stored fingerprint is different from incoming
        try {
          // If updateContactFingerprint is implemented:
          // await vaultService.updateContactFingerprint(25, 'new_fingerprint', 'old_fingerprint');
          // return true;
          return false;
        } catch (e) {
          return false;
        }
      });

      console.log('Warning triggered:', warningTriggered);

      // Navigate to messages
      await ensureMessagesUnlocked(page, USER1.password);

      // Look for fingerprint warning banner
      const warningBanner = page.locator('.fingerprint-warning-banner, .key-change-warning');

      // When feature is implemented and fingerprint changed:
      // await expect(warningBanner).toBeVisible();
      // await expect(warningBanner).toContainText('key has changed');

    } finally {
      await context.close();
    }
  });

  test('should persist verification status after logout/login', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginUser(page, USER1);
      await page.goto('/#messages');
      await page.waitForTimeout(2000);

      // Verify a contact (if contact verification is implemented)
      // ... verification flow ...

      // Store the verification status before logout
      const bobId = await getUserIdByUsername(page, USER2.name);
      const statusBefore = await page.evaluate(async (contactId) => {
        const vaultService = window.vaultService;
        if (!vaultService || !contactId) return null;

        try {
          const fp = await vaultService.getContactFingerprint(contactId);
          return fp?.status;
        } catch (e) {
          return null;
        }
      }, bobId);

      console.log('Status before logout:', statusBefore);

      // Logout (clear token but keep IndexedDB)
      await page.evaluate(() => {
        localStorage.removeItem('token');
        location.hash = '#login';
      });
      await page.waitForURL('**/#login');

      // Login again
      await loginUser(page, USER1);

      // Check verification status is preserved
      const statusAfter = await page.evaluate(async (contactId) => {
        const vaultService = window.vaultService;
        if (!vaultService || !contactId) return null;

        try {
          const fp = await vaultService.getContactFingerprint(contactId);
          return fp?.status;
        } catch (e) {
          return null;
        }
      }, bobId);

      console.log('Status after login:', statusAfter);

      // When feature is implemented:
      // expect(statusAfter).toBe(statusBefore);

    } finally {
      await context.close();
    }
  });

  test('should copy fingerprint to clipboard', async ({ browser, browserName }) => {
    test.skip(browserName === 'firefox', 'Clipboard permissions not supported in Firefox');

    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write']
    });
    const page = await context.newPage();

    try {
      await loginUser(page, USER1);
      await page.goto('/#messages');
      await page.waitForTimeout(2000);

      // Select a conversation
      const convItem = page.locator('.conversation-item, .chat-item').first();
      if (await convItem.isVisible()) {
        await convItem.click();
        await page.waitForTimeout(1000);

        // Open Safety Numbers modal
        const safetyBtn = page.locator('.btn-safety-numbers, button[title*="Safety"], button:has-text("🛡️")');
        if (await safetyBtn.isVisible()) {
          await safetyBtn.click();
          await page.waitForTimeout(500);

          // Click copy button
          const copyBtn = page.locator('button:has-text("Copy"), .copy-btn');
          if (await copyBtn.isVisible()) {
            await copyBtn.click();
            await page.waitForTimeout(500);

            // Verify clipboard contains fingerprint
            const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
            console.log('Clipboard content:', clipboardText);

            // Should be hex characters and spaces
            expect(clipboardText).toMatch(/[A-F0-9\s]+/i);
          }
        }
      }

    } finally {
      await context.close();
    }
  });

});

test.describe.skip('LEGACY: Safety Numbers Integration with Messaging (quarantined)', () => {

  test.beforeEach(async () => {
    await resetServerState();
  });

  test('should capture fingerprint from welcome message', async ({ browser }) => {
    // Clear and setup fresh
    const tempContext = await browser.newContext();
    const tempPage = await tempContext.newPage();
    await clearBrowserStorage(tempPage);
    await tempContext.close();

    const contextAlice = await browser.newContext();
    const pageAlice = await contextAlice.newPage();

    const contextBob = await browser.newContext();
    const pageBob = await contextBob.newPage();

    try {
      // Login users
      await loginUser(pageAlice, USER1);
      await loginUser(pageBob, USER2);

      // Alice starts DM
      await startDmWithUser(pageAlice, USER2);

      await ensureMessagesUnlocked(pageBob, USER2.password);

      // Check for pending welcomes
      const welcomeInfo = await pageBob.evaluate(async () => {
        const coreCryptoClient = window.coreCryptoClient;
        if (!coreCryptoClient) return { error: 'no client' };

        const pending = coreCryptoClient.pendingWelcomes;
        if (pending.size === 0) return { pending: 0 };

        // Get first pending welcome info
        const [pendingId, invite] = pending.entries().next().value;
        return {
          pending: pending.size,
          pendingId,
          // senderFingerprint would be captured here
        };
      });

      console.log('Welcome info:', welcomeInfo);

      // When feature is implemented:
      // Bob accepts welcome, and Alice's fingerprint should be captured
      // expect(welcomeInfo.senderFingerprint).toBeDefined();

    } finally {
      await contextAlice.close();
      await contextBob.close();
    }
  });

  test('should not break messaging when fingerprint changes', async ({ browser }) => {
    // Even with fingerprint warnings, messaging should still work
    // This ensures the warning is informational, not blocking

    const contextAlice = await browser.newContext();
    const pageAlice = await contextAlice.newPage();

    const contextBob = await browser.newContext();
    const pageBob = await contextBob.newPage();

    try {
      const tempContext = await browser.newContext();
      const tempPage = await tempContext.newPage();
      await clearBrowserStorage(tempPage);
      await tempContext.close();

      await loginUser(pageAlice, USER1);
      await loginUser(pageBob, USER2);

      // Simulate Alice having a changed fingerprint for Bob
      const bobId = await getAuthedUserId(pageBob);
      await pageAlice.evaluate(async (contactId) => {
        const vaultService = window.vaultService;
        if (!vaultService || !vaultService.updateContactFingerprint) return;

        // Mark Bob's fingerprint as changed
        try {
          if (contactId) {
            await vaultService.updateContactFingerprint(contactId, 'new_fp', 'old_fp');
          }
        } catch (e) {
          // Feature not yet implemented
        }
      }, bobId);

      // Alice should still be able to send messages
      await ensureMessagesUnlocked(pageAlice, USER1.password);

      const convItem = pageAlice.locator('.conversation-item').filter({ hasText: USER2.name });
      if (await convItem.isVisible()) {
        await convItem.click();
        await pageAlice.waitForTimeout(1000);

        // Warning might be shown, but messaging should work
        const testMessage = `Test message after warning ${Date.now()}`;
        await pageAlice.locator('.message-textarea').fill(testMessage);
      await pageAlice.locator('.send-button').click();
      await expect(pageAlice.locator('.message-item.sent .message-text'))
        .toContainText(testMessage, { timeout: 15000 });

        // Message should be sent successfully
        await expect(pageAlice.locator('.message-item.sent .message-text')).toContainText(testMessage, { timeout: 15000 });
      }

    } finally {
      await contextAlice.close();
      await contextBob.close();
    }
  });
});
