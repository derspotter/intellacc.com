const { test, expect } = require('@playwright/test');

const VAN_URL = process.env.VAN_URL || 'http://127.0.0.1:5173';
const SOLID_URL = process.env.SOLID_URL || 'http://127.0.0.1:5174';

const USER_SOLID = { email: 'user1@example.com', password: 'password123', username: 'testuser1' };
const USER_VAN = { email: 'user2@example.com', password: 'password123', username: 'testuser2' };

async function resetServerState() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('./tests/e2e/reset-test-users.sh', () => resolve());
  });
}

async function loginOnSolid(page, user) {
  await page.goto(`${SOLID_URL}/#login`);
  await page.getByPlaceholder('Enter system address...').fill(user.email);
  await page.getByRole('button', { name: '> CONTINUE' }).click();
  await page.getByPlaceholder('Enter access key...').fill(user.password);
  await page.getByRole('button', { name: '> SIGN IN' }).click();
  await expect(page.getByText(`[INTELLACC] USER: @${user.username}`)).toBeVisible({ timeout: 20000 });
}

async function unlockSolidVaultIfNeeded(page, password) {
  const unlockBtn = page.getByRole('button', { name: '> UNLOCK VAULT' });
  if (await unlockBtn.isVisible().catch(() => false)) {
    await page.getByPlaceholder('Vault Password...').fill(password);
    await unlockBtn.click();
  }
}

function solidChatPanel(page) {
  return page.locator('div.bg-bb-panel').filter({ hasText: '[3] COMMS // E2EE' }).first();
}

async function openDmOnSolid(page, otherUsername, timeoutMs = 90000) {
  const panel = solidChatPanel(page);
  await expect(panel).toBeVisible({ timeout: 20000 });

  const deadline = Date.now() + timeoutMs;
  const target = otherUsername.toUpperCase();

  while (Date.now() < deadline) {
    await panel.locator('button[title="Refresh"]').click().catch(() => {});

    const dmRow = panel.locator('div.cursor-pointer').filter({ hasText: target }).first();
    if (await dmRow.isVisible().catch(() => false)) {
      await dmRow.click();
      const input = panel.getByPlaceholder('// Type message...');
      if (await input.isEnabled().catch(() => false)) return;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for Solid DM row for ${otherUsername}`);
}

async function waitForSolidIncomingText(page, text, timeoutMs = 90000) {
  const panel = solidChatPanel(page);
  await expect(panel).toBeVisible({ timeout: 20000 });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await panel.getByText(text).first().isVisible().catch(() => false)) return;
    await panel.locator('button[title="Refresh"]').click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  throw new Error('Timed out waiting for Solid to display incoming message');
}

async function sendFromSolid(page, text) {
  const panel = solidChatPanel(page);
  const input = panel.getByPlaceholder('// Type message...');
  await expect(input).toBeEnabled({ timeout: 30000 });
  await input.fill(text);
  await panel.locator('button').filter({ hasText: 'TRANSMIT' }).first().click();
  await expect(panel.getByText(text).first()).toBeVisible({ timeout: 20000 });
}

async function loginOnVan(page, user) {
  await page.goto(`${VAN_URL}/#login`);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 20000 });
}

async function openVanMessagesUnlocked(page, password) {
  await page.goto(`${VAN_URL}/#messages`);
  await expect(page.locator('.messages-page')).toBeVisible({ timeout: 20000 });

  const unlockMessaging = page.getByRole('button', { name: 'Unlock Messaging' });
  if (await unlockMessaging.isVisible().catch(() => false)) {
    await unlockMessaging.click();
    await page.getByPlaceholder('Login Password').fill(password);
    await page.locator('.unlock-modal').getByRole('button', { name: 'Unlock' }).click();
  }

  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible().catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
  }
}

async function acceptWelcomeIfPresent(page) {
  const acceptBtn = page.getByRole('button', { name: 'Accept' }).first();
  if (await acceptBtn.isVisible().catch(() => false)) {
    await acceptBtn.click();
  }
}

async function startDmFromVan(page, targetUsername) {
  const newBtn = page.locator('button:has-text("+ New"), button:has-text("New")');
  await expect(newBtn.first()).toBeVisible({ timeout: 15000 });
  await newBtn.first().click();

  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]');
  await expect(searchInput.first()).toBeVisible({ timeout: 15000 });
  await searchInput.first().fill(targetUsername);

  const userRow = page
    .locator('.user-row, .user-item, [data-user]')
    .filter({ hasText: targetUsername })
    .first();
  await expect(userRow).toBeVisible({ timeout: 20000 });
  await userRow.click();

  const startDmBtn = page.locator('button:has-text("Start DM"), button:has-text("Start"), button:has-text("Message")');
  await expect(startDmBtn.first()).toBeVisible({ timeout: 15000 });
  await startDmBtn.first().click();
}

async function openDmOnVan(page, otherUsername) {
  const dm = page.locator('.conversation-item').filter({ hasText: otherUsername }).first();
  await expect(dm).toBeVisible({ timeout: 30000 });
  await dm.click();
}

async function sendFromVan(page, text) {
  await page.locator('.message-textarea').fill(text);
  await page.locator('.send-button').click();
  await expect(page.locator('.message-item.sent .message-text').filter({ hasText: text })).toBeVisible({ timeout: 20000 });
}

test.describe('Cross-Frontend Messaging Interop', () => {
  test.beforeAll(async () => {
    await resetServerState();
  });

  test('Solid user and Van user can exchange messages', async ({ browser }) => {
    test.setTimeout(120000);

    const solidCtx = await browser.newContext();
    const solidPage = await solidCtx.newPage();
    const vanCtx = await browser.newContext();
    const vanPage = await vanCtx.newPage();

    const msgVanToSolid = `van->solid ${Date.now()}`;
    const msgSolidToVan = `solid->van ${Date.now() + 1}`;

    // Initialize both users and messaging state.
    await loginOnSolid(solidPage, USER_SOLID);
    await unlockSolidVaultIfNeeded(solidPage, USER_SOLID.password);

    await loginOnVan(vanPage, USER_VAN);
    await openVanMessagesUnlocked(vanPage, USER_VAN.password);
    await acceptWelcomeIfPresent(vanPage);

    // Van initiates DM and sends first message.
    await startDmFromVan(vanPage, USER_SOLID.username);
    await sendFromVan(vanPage, msgVanToSolid);

    // Solid receives and replies via Solid UI.
    await openDmOnSolid(solidPage, USER_VAN.username, 90000);
    await waitForSolidIncomingText(solidPage, msgVanToSolid, 90000);
    await sendFromSolid(solidPage, msgSolidToVan);

    // Van receives Solid reply.
    await openVanMessagesUnlocked(vanPage, USER_VAN.password);
    await acceptWelcomeIfPresent(vanPage);
    await openDmOnVan(vanPage, USER_SOLID.username);
    await expect(vanPage.locator('.message-item.received .message-text').filter({ hasText: msgSolidToVan })).toBeVisible({ timeout: 30000 });

    await solidCtx.close();
    await vanCtx.close();
  });
});
